using System.Diagnostics;

namespace PermitWitness.Windows;

internal sealed record V2Event(long Sequence, long ElapsedTicks, string Code);
internal sealed record V2Outcome(string Kind, V2Response? Response);
internal sealed record V2Snapshot(V2Outcome Outcome, V2Response? ServerFact, V2Event[] Events,
    int Dispatches, int Responses, bool ReaderExited, bool WorkerExited);

// One already-authenticated duplex stream, one exchange, one application reader.
// No listener, connect, certificate access, TLS policy switch or automatic retry.
// Start -> await Completion -> FinishAsync. Completion publishes the business
// result independently of reader cleanup; deadline also aborts unattended work.
// Stream ownership transfers to this object. Dispose must interrupt native I/O;
// a non-cooperative tracked operation is reported and retains its quota.
//
// TRUSTED INTEGRATION CONTRACT (review prerequisite, NOT runtime enforcement):
// Executors/backends MUST NOT register async void cancellation callbacks or
// detach fire-and-forget work. Register synchronous callbacks that only signal
// cancellation; await asynchronous work/cleanup in the executor's returned Task
// (including its finally), or in the backend's tracked ReadAsync/WriteAsync task.
// Synchronous policy/Dispose callbacks must not leave detached work behind either.
//
// The raw CancellationToken/Stream seams cannot inspect later registrations or
// discover arbitrary continuations. CancelAsync joins callback delegate returns,
// NOT async void tails or their exceptions. WhenReleased/admission bounds depend
// on trusted implementations honoring this contract; they are NOT proof that
// uncontrolled code exited, a sandbox, or an unconditional resource guarantee.
// An unverifiable executor/backend remains an integration blocker; this candidate
// supplies no enforcement mechanism or production bootstrap for it.
internal sealed class V2Exchange
{
    internal const int MaxActive = 4;
    private static readonly SemaphoreSlim Admission = new(MaxActive, MaxActive); // No queue.
    // Per admitted exchange: <= 1 MiB body, 64 KiB receive batch, one detached
    // request and response plus encoding copies. Transport-owned buffers <8 MiB.
    // Payload policies/providers must bound their own allocations; not a service
    // load/transaction-capacity claim. Timed-out workers retain admission.
    private readonly object gate = new();
    private readonly Stream stream;
    private readonly IV2PayloadPolicy policy;
    private readonly Func<V2Request, CancellationToken, Task<V2Response>>? dispatch;
    private readonly V2Frames.Decoder decoder;
    private readonly CancellationTokenSource deadline;
    private readonly CancellationTokenSource lifetime;
    private readonly CancellationTokenSource readStop = new();
    private readonly TaskCompletionSource<V2Outcome> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource readerExited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource workerExited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource cleanupFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource watcherExited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource resourcesReleased = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<V2Event> events = [];
    private readonly long started = Stopwatch.GetTimestamp();
    private readonly TimeSpan timeout;
    private readonly TimeSpan closeBudget;
    private V2Request? request;
    private V2Outcome? outcome;
    private V2Response? serverFact;
    private bool closing;
    private bool requestMayHaveBeenSent;
    private bool dispatchReserved;
    private bool responseAttempted;
    private int dispatches;
    private int responses;
    private bool cleanupStarted;

    private V2Exchange(Stream stream, IV2PayloadPolicy policy, TimeSpan timeout, TimeSpan closeBudget,
        CancellationToken cancellation, V2Request? request,
        Func<V2Request, CancellationToken, Task<V2Response>>? dispatch)
    {
        ArgumentNullException.ThrowIfNull(stream);
        ArgumentNullException.ThrowIfNull(policy);
        if (timeout < TimeSpan.FromMilliseconds(1) || timeout > TimeSpan.FromSeconds(30) ||
            closeBudget < TimeSpan.FromMilliseconds(1) || closeBudget > TimeSpan.FromSeconds(1))
            throw new ArgumentOutOfRangeException(nameof(timeout));
        cancellation.ThrowIfCancellationRequested();
        if (!Admission.Wait(0)) throw new InvalidOperationException("ERR_V2_CAPACITY");
        this.stream = stream;
        this.policy = policy;
        this.timeout = timeout;
        this.closeBudget = closeBudget;
        this.request = request;
        this.dispatch = dispatch;
        decoder = new(response: dispatch is null);
        // Only the private deadline signal is linked/timed. Executor callbacks
        // run through guarded cancellation, never on the caller's Cancel/timer.
        deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        lifetime = new();
        deadline.CancelAfter(timeout); // Never reset by reads, fragments or extra data.
    }

    internal Task<V2Outcome> Completion => completion.Task;
    // Joins only the owned tasks and synchronous callback invocations under the
    // trusted integration contract above; hidden async void work is unobservable.
    internal Task WhenReleased => resourcesReleased.Task;

    // dispatch must own/join ALL of its async work before its returned Task exits.
    // Its token registrations must be synchronous signals, never async void.
    internal static V2Exchange StartServer(Stream authenticatedStream, IV2PayloadPolicy boundPolicy,
        Func<V2Request, CancellationToken, Task<V2Response>> dispatch, TimeSpan timeout,
        TimeSpan closeBudget, CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(dispatch);
        var exchange = new V2Exchange(authenticatedStream, boundPolicy, timeout, closeBudget, cancellation, null, dispatch);
        exchange.Start();
        return exchange;
    }

    internal static V2Exchange StartClient(Stream authenticatedStream, IV2PayloadPolicy boundPolicy,
        V2Request request, TimeSpan timeout, TimeSpan closeBudget, CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Payload.Length is < 1 or > V2Frames.MaxPayload || request.Operation is not (1 or 2))
            throw new ProtocolException();
        // Detach before any asynchronous work, so the caller cannot mutate the
        // request used for correlation and per-action response validation.
        var copy = request with { Payload = request.Payload.ToArray() };
        var exchange = new V2Exchange(authenticatedStream, boundPolicy, timeout, closeBudget, cancellation, copy, null);
        exchange.Start();
        return exchange;
    }

    private void Start()
    {
        _ = ReleaseWhenExitedAsync();
        _ = WatchDeadlineAsync();
        if (dispatch is not null) _ = ReadLoopAsync();
        else _ = SendRequestAsync();
    }

    private void Event(string code) => events.Add(new(events.Count + 1, Stopwatch.GetTimestamp() - started, code));

    // Check the monotonic absolute budget after synchronous policy/provider
    // returns, not just a potentially delayed timer callback.
    private bool Live()
    {
        if (closing) return false;
        if (!deadline.IsCancellationRequested && !lifetime.IsCancellationRequested &&
            Stopwatch.GetElapsedTime(started) < timeout) return true;
        Terminate("DEADLINE_OR_CANCEL");
        return false;
    }

    private void Fix(V2Outcome value)
    {
        if (outcome is not null) return;
        outcome = value;
        Event("BUSINESS_FIXED_" + value.Kind.ToUpperInvariant());
        completion.TrySetResult(value with { Response = value.Response is null ? null : Copy(value.Response) });
    }

    private void Terminate(string code)
    {
        Event(code);
        closing = true;
        Fix(new(requestMayHaveBeenSent || dispatches != 0 ? "unknown" : "local-not-attempted", null));
        StartCleanup();
    }

    private async Task CancelWithDiagnosticAsync(CancellationTokenSource source, string diagnostic)
    {
        // Async void callbacks violate the trusted contract: neither their tails
        // nor post-await exceptions can be joined/caught by this Task.
        try { await source.CancelAsync(); }
        catch (AggregateException) { lock (gate) Event(diagnostic); }
    }

    private async Task WatchDeadlineAsync()
    {
        try
        {
            try { await Task.Delay(Timeout.InfiniteTimeSpan, deadline.Token); }
            catch (OperationCanceledException) { }
            lock (gate)
            {
                if (!closing) Terminate("DEADLINE_OR_CANCEL");
            }
            await FinishAsync();
        }
        finally { watcherExited.TrySetResult(); }
    }

    private async Task SendRequestAsync()
    {
        bool reading = false;
        try
        {
            lock (gate) { if (!Live()) return; }
            policy.ValidateRequest(Copy(request!));
            byte[] encoded = V2Frames.Encode(request!);
            lock (gate)
            {
                if (!Live()) return;
                requestMayHaveBeenSent = true; // A partial write may already reach the peer.
                Event("REQUEST_SEND_STARTED");
            }
            await stream.WriteAsync(encoded, lifetime.Token);
            lock (gate) { if (!Live()) return; }
            await stream.FlushAsync(lifetime.Token);
            lock (gate)
            {
                if (!Live()) return;
                Event("REQUEST_SENT_OPEN"); // No Shutdown(Send), ShutdownAsync or EOF probe.
                reading = true;
            }
            _ = ReadLoopAsync();
        }
        catch (Exception) { lock (gate) Terminate("REQUEST_SEND_FAILED"); }
        finally
        {
            workerExited.TrySetResult();
            if (!reading) readerExited.TrySetResult();
        }
    }

    private async Task ReadLoopAsync()
    {
        var buffer = new byte[65_536];
        try
        {
            while (true)
            {
                // Reserve the sole read under gate, invoke the backend outside.
                // Closing can cancel a reserved read before its backend starts;
                // readerExited still owns its quota even if it ignores the token.
                lock (gate) { if (!Live()) break; }
                int count = await stream.ReadAsync(buffer, readStop.Token);
                bool launch = false;
                V2Request? validateRequest = null;
                V2Response? validateResponse = null;
                lock (gate)
                {
                    if (!Live()) { Event("LATE_READ_IGNORED"); break; }
                    if (count == 0)
                    {
                        // Stream EOF cannot distinguish close_notify from bare FIN.
                        Terminate(decoder.Complete ? "EOF_UNKNOWN_CLOSE" : "TRUNCATED_UNKNOWN_CLOSE");
                        break;
                    }
                    bool alreadyComplete = decoder.Complete;
                    decoder.Append(buffer.AsSpan(0, count));
                    if (!decoder.Complete) continue;
                    if (dispatch is not null)
                    {
                        if (decoder.Trailing)
                        {
                            Terminate(dispatches != 0 ? "TRAILING_AFTER_DISPATCH" : "TRAILING_BEFORE_DISPATCH");
                            break;
                        }
                        if (!alreadyComplete)
                        {
                            request = new(decoder.Operation, decoder.RequestId, decoder.Payload.ToArray());
                            validateRequest = request;
                        }
                    }
                    else
                    {
                        if (!alreadyComplete)
                        {
                            validateResponse = new V2Response(decoder.Operation, decoder.RequestId,
                                decoder.Status, decoder.Payload.ToArray());
                        }
                        // Fix the first fully validated business result BEFORE
                        // processing extra bytes from even the very same batch.
                        if (alreadyComplete && decoder.Trailing) { Terminate("TRAILING_AFTER_RESPONSE"); break; }
                    }
                }
                if (validateRequest is not null)
                {
                    policy.ValidateRequest(Copy(validateRequest));
                    lock (gate)
                    {
                        if (!Live()) break;
                        Event("FRAME_VALIDATED");
                        // Checkpoint has syntax only; never dispatch a query.
                        if (validateRequest.Operation == 1) { Terminate("CHECKPOINT_QUERY_UNSUPPORTED"); break; }
                    }
                    policy.AuthorizeRequest(Copy(validateRequest));
                    lock (gate)
                    {
                        if (!Live()) break;
                        dispatchReserved = launch = true;
                        Event("DISPATCH_RESERVED");
                    }
                }
                if (validateResponse is not null)
                {
                    ValidateResponse(validateResponse);
                    lock (gate)
                    {
                        if (!Live()) break;
                        Event("RESPONSE_VALIDATED");
                        Fix(new("response", validateResponse));
                        if (decoder.Trailing) { Terminate("TRAILING_AFTER_RESPONSE"); break; }
                    }
                }
                if (launch) _ = Task.Run(DispatchAsync); // Single admitted worker; never a second request.
            }
        }
        catch (Exception) { lock (gate) { if (!closing) Terminate("READ_OR_VALIDATION_FAILED"); } }
        finally
        {
            readerExited.TrySetResult();
            lock (gate) { if (dispatch is not null && !dispatchReserved) workerExited.TrySetResult(); }
        }
    }

    private async Task DispatchAsync()
    {
        try
        {
            lock (gate)
            {
                if (!Live()) return;
                dispatches++;
                Event("DISPATCHED");
            }
            // Dispatch is reserved once under gate. Reentrancy/closing cannot
            // dispatch again; cooperative cancellation never proves rollback.
            V2Response supplied = await dispatch!(Copy(request!), lifetime.Token);
            if (supplied.Payload.Length is < 1 or > V2Frames.MaxPayload) throw new ProtocolException();
            var response = Copy(supplied);
            ValidateResponse(response);
            byte[] encoded = V2Frames.Encode(response);
            lock (gate)
            {
                // Keep the authoritative executor fact separate even if the
                // client has already become unknown. No rollback assertion.
                serverFact = response;
                Event(response.Status == 0 ? "COMMIT_CONFIRMED" : "SERVER_STATUS_" + response.Status);
                if (!Live()) { Event("LATE_BUSINESS_RETURN_NO_SEND"); return; }
                responseAttempted = true;
                Event("RESPONSE_SEND_STARTED");
            }
            await stream.WriteAsync(encoded, lifetime.Token);
            lock (gate) { if (!Live()) return; }
            await stream.FlushAsync(lifetime.Token);
            lock (gate)
            {
                if (!Live()) return;
                responses++;
                Event("RESPONSE_SENT");
                Fix(new("server-result", response)); // Local send is NOT client validation.
            }
        }
        catch (Exception)
        {
            lock (gate) Terminate(responseAttempted ? "RESPONSE_SEND_FAILED" : "BUSINESS_OUTCOME_UNKNOWN");
        }
        finally { workerExited.TrySetResult(); }
    }

    private static V2Request Copy(V2Request value) => value with { Payload = value.Payload.ToArray() };
    private static V2Response Copy(V2Response value) => value with { Payload = value.Payload.ToArray() };

    private void ValidateResponse(V2Response response)
    {
        if (response.Operation != request!.Operation || response.RequestId != request.RequestId || response.Status > 3 ||
            response.Payload.Length is < 1 or > V2Frames.MaxPayload) throw new ProtocolException();
        policy.ValidateResponse(Copy(request), Copy(response));
    }

    internal V2Snapshot Snapshot()
    {
        lock (gate) return new(outcome is null ? new("pending", null) : outcome with
        { Response = outcome.Response is null ? null : Copy(outcome.Response) },
            serverFact is null ? null : Copy(serverFact), events.ToArray(), dispatches, responses,
            readerExited.Task.IsCompleted, workerExited.Task.IsCompleted);
    }

    internal Task FinishAsync()
    {
        lock (gate)
        {
            StartCleanup();
            return cleanupFinished.Task;
        }
    }

    // Called under gate. Publish BOTH closing and the unique cleanup owner
    // before scheduling anything that can reenter FinishAsync/Snapshot.
    private void StartCleanup()
    {
        if (cleanupStarted) return;
        cleanupStarted = true;
        closing = true; // No new read reservation after this point.
        if (outcome is null) Fix(new(requestMayHaveBeenSent || dispatches != 0 ? "unknown" : "local-not-attempted", null));
        Event("READER_CLOSING");
        _ = Task.Run(FinishCoreAsync);
    }

    private async Task FinishCoreAsync()
    {
        // Cleanup ownership is already published. All external cancellation,
        // policy, executor and stream callbacks run outside gate, including
        // synchronous callback prefixes. Callback reentry only gets the same task.
        // CancelAsync publishes cancellation synchronously but runs registered
        // callbacks asynchronously. Start BOTH before disposal, without awaiting
        // either: an executor callback may wait for reader exit, while a read
        // callback may need disposal. Keep both tasks until their synchronous
        // callback invocations return; async void tails are outside this guarantee.
        Task cancelLifetime = CancelWithDiagnosticAsync(lifetime, "LIFETIME_CANCEL_CALLBACK_FAILED");
        Task cancelRead = CancelWithDiagnosticAsync(readStop, "READ_CANCEL_CALLBACK_FAILED");
        // No backend-specific safe reader/shutdown handoff has been validated.
        // Abort only AFTER response send/accept or a terminal path. Never invoke
        // a TLS shutdown that might read concurrently with the application pump.
        // Cancellation/Dispose is explicitly NOT a close_notify claim.
        // The reader wait is bounded below; synchronous Dispose/policy/provider
        // calls still have no hard wall-clock bound on an unverified backend.
        try { stream.Dispose(); }
        catch (Exception) { lock (gate) Event("DISPOSE_FAILED"); }
        try { await readerExited.Task.WaitAsync(closeBudget); }
        catch (TimeoutException) { lock (gate) Event("READER_DID_NOT_EXIT"); }
        lock (gate)
        {
            Event("ABORT_UNKNOWN_CLOSE");
        }
        deadline.Cancel();
        await Task.WhenAll(cancelLifetime, cancelRead);
        cleanupFinished.TrySetResult();
    }

    private async Task ReleaseWhenExitedAsync()
    {
        await Task.WhenAll(readerExited.Task, workerExited.Task, cleanupFinished.Task, watcherExited.Task);
        readStop.Dispose();
        lifetime.Dispose();
        deadline.Dispose();
        // Stuck owned tasks/synchronous callbacks retain capacity. This cannot
        // account for detached work from an integration violating the contract.
        Admission.Release();
        resourcesReleased.TrySetResult();
    }
}

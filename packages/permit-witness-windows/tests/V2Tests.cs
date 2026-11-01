using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using PermitWitness.Windows;

// Controlled application-stream tests, NOT TLS, trust, authority or persistence
// tests. TestPolicy uses the existing OFFLINE JS wire validator on original
// payload bytes; no permissive schema stub or executable production policy.
internal static class V2Tests
{
    private static readonly Guid Id = Guid.Parse("00112233-4455-6677-8899-aabbccddeeff");
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan CloseBudget = TimeSpan.FromMilliseconds(100);
    private static V2Request request = null!;
    private static V2Response[] responses = [];
    private static byte[] checkpoint = [];
    private static V2Request consume = null!;
    private static V2Response consumeResponse = null!;
    private static V2Request issue = null!;
    private static V2Response issueUnavailable = null!;
    private static V2Response issueInvalidSignature = null!;
    private static int passed;
    private static int evidence;
    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal static async Task RunAsync()
    {
        using (var fixture = JsonDocument.Parse(Node(new { fixtures = true })))
        {
            var root = fixture.RootElement;
            request = new(2, Id, Convert.FromHexString(root.GetProperty("request").GetString()!));
            responses = root.GetProperty("responses").EnumerateArray().Select((item, status) =>
                new V2Response(2, Id, (byte)status, Convert.FromHexString(item.GetString()!))).ToArray();
            checkpoint = Convert.FromHexString(root.GetProperty("checkpoint").GetString()!);
            consume = new(2, Id, Convert.FromHexString(root.GetProperty("consume").GetString()!));
            consumeResponse = new(2, Id, 0, Convert.FromHexString(root.GetProperty("consumeResponse").GetString()!));
            issue = new(2, Id, Convert.FromHexString(root.GetProperty("issue").GetString()!));
            issueUnavailable = new(2, Id, 3, Convert.FromHexString(root.GetProperty("issueUnavailable").GetString()!));
            issueInvalidSignature = new(2, Id, 0, Convert.FromHexString(root.GetProperty("issueInvalidSignature").GetString()!));
        }
        // Warm the test oracle before timing-specific cases; policies are still
        // invoked at every boundary. Cache keys include ALL original frame bytes.
        var strict = new TestPolicy();
        strict.ValidateRequest(request);
        foreach (var response in responses) strict.ValidateResponse(request, response);
        strict.ValidateRequest(consume); strict.ValidateRequest(issue);
        strict.ValidateResponse(consume, consumeResponse); strict.ValidateResponse(issue, issueUnavailable);

        await Check("v2 vectors, segmentation, exact unsigned role-specific length limits and v1 isolation", async () =>
        {
            var req = new V2Request(1, Id, Bytes("{}"));
            var res = new V2Response(1, Id, 0, Bytes("{}"));
            Assert(Convert.ToHexString(V2Frames.Encode(req)) == "00000014020100112233445566778899AABBCCDDEEFF7B7D");
            Assert(Convert.ToHexString(V2Frames.Encode(res)) == "00000015020100112233445566778899AABBCCDDEEFF007B7D");
            foreach (bool response in new[] { false, true })
            {
                byte[] frame = response ? V2Frames.Encode(res) : V2Frames.Encode(req);
                for (int split = 0; split <= frame.Length; split++)
                {
                    var decoder = new V2Frames.Decoder(response);
                    decoder.Append(frame.AsSpan(0, split));
                    decoder.Append(frame.AsSpan(split));
                    Assert(decoder.Complete && !decoder.Trailing && decoder.RequestId == Id &&
                        decoder.Operation == 1 && decoder.Payload.Span.SequenceEqual(Bytes("{}")));
                }
                var segmented = new V2Frames.Decoder(response);
                foreach (byte value in frame) segmented.Append(new byte[] { value });
                Assert(segmented.Complete && !segmented.Trailing);
                segmented.Append(new byte[] { 0 });
                Assert(segmented.Trailing);
                int header = response ? 19 : 18;
                foreach (uint length in new[] { 0u, (uint)header, (uint)(header + V2Frames.MaxPayload + 1), uint.MaxValue })
                {
                    byte[] prefix = new byte[4];
                    System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(prefix, length);
                    Throws<ProtocolException>(() => new V2Frames.Decoder(response).Append(prefix));
                }
                var maximum = Enumerable.Repeat((byte)0x7b, V2Frames.MaxPayload).ToArray();
                var large = response ? V2Frames.Encode(res with { Payload = maximum }) : V2Frames.Encode(req with { Payload = maximum });
                Assert(large.Length == 4 + header + V2Frames.MaxPayload);
                var maxDecoder = new V2Frames.Decoder(response);
                for (int offset = 0; offset < large.Length; offset += 8191)
                    maxDecoder.Append(large.AsSpan(offset, Math.Min(8191, large.Length - offset)));
                Assert(maxDecoder.Complete && maxDecoder.Payload.Span.SequenceEqual(maximum));
                byte[] v1 = (byte[])frame.Clone(); v1[4] = 1;
                Throws<ProtocolException>(() => new V2Frames.Decoder(response).Append(v1));
            }
            using var oldReader = new MemoryStream(V2Frames.Encode(req));
            await ThrowsAsync<ProtocolException>(async () => await Frames.ReadRequestAsync(oldReader, default));
            Assert(Frames.EncodeRequest(1, Id, Bytes("{}"))[4] == 1);
            Throws<ProtocolException>(() => V2Frames.Encode(req with { Payload = new byte[V2Frames.MaxPayload + 1] }));
            Throws<ProtocolException>(() => V2Frames.Encode(res with { Status = 4 }));
        });

        await Check("three duplex exchanges dispatch and accept while BOTH send directions stay open", async () =>
        {
            for (int run = 0; run < 3; run++)
            {
                var clientStream = new ControlledStream();
                var serverStream = new ControlledStream();
                clientStream.Peer = serverStream; serverStream.Peer = clientStream;
                var entered = Signal(); var release = Signal();
                var server = Server(serverStream, async (_, _) => { entered.SetResult(); await release.Task; return responses[0]; });
                var client = Client(clientStream);
                await entered.Task.WaitAsync(Budget);
                Assert(!server.Completion.IsCompleted && !client.Completion.IsCompleted);
                Assert(!clientStream.Disposed && !serverStream.Disposed && clientStream.Writes.Count == 1);
                release.SetResult();
                Assert((await client.Completion.WaitAsync(Budget)).Response!.Status == 0);
                Assert((await server.Completion.WaitAsync(Budget)).Kind == "server-result");
                Assert(clientStream.MaxReaders == 1 && serverStream.MaxReaders == 1);
                Assert(!clientStream.Disposed && !serverStream.Disposed); // Neither EOF required.
                Assert(server.Snapshot().Dispatches == 1 && serverStream.Writes.Count == 1);
                await Finish(client); await Finish(server);
            }
        });

        await Check("same-batch request tail: byte, second frame and fragment dispatch ZERO times", async () =>
        {
            byte[] frame = V2Frames.Encode(request);
            foreach (byte[] tail in new[] { new byte[] { 0 }, frame, frame[..9] })
            {
                var stream = new ControlledStream(); stream.Deliver([.. frame, .. tail]);
                int calls = 0;
                var server = Server(stream, (_, _) => { calls++; return Task.FromResult(responses[0]); });
                await server.Completion.WaitAsync(Budget);
                await Finish(server);
                Assert(calls == 0 && server.Snapshot().Dispatches == 0 && stream.Writes.Count == 0);
                Has(server, "TRAILING_BEFORE_DISPATCH");
            }
        });

        await Check("original-byte payload validation rejects malformed UTF8/JSON/canonical/schema before dispatch", async () =>
        {
            string valid = Encoding.UTF8.GetString(request.Payload.Span);
            var badPayloads = new List<byte[]>
            {
                Bytes("{}"), Bytes("{not-json"), Bytes(valid + " "), Bytes("\uFEFF" + valid),
                Bytes(valid.Replace("\"format_version\":1", "\"format_version\":2")),
                Bytes(valid.Replace("\"format_version\":1", "\"format_version\":1.0")),
                Bytes(valid.Replace("\"action\":\"register\"", "\"action\":\"register\",\"action\":\"register\"")),
                Bytes(valid.Replace("\"action\":\"register\"", "\"action\":\"register\",\"\\u0061ction\":\"register\"")),
                Bytes(valid.Replace("\"action\":\"register\"", "\"action\":\"deriveTransition\"")),
                Bytes(valid.Replace("\"format_version\":1", "\"facts\":{},\"format_version\":1")),
                Bytes("{\"x\":\"" + new string('x', 65537) + "\"}"),
                Bytes("{\"x\":" + new string('[', 18) + "0" + new string(']', 18) + "}"),
                Bytes("{\"x\":[" + string.Join(',', Enumerable.Repeat("0", 1025)) + "]}"),
                new byte[] { 0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d },
            };
            foreach (byte[] payload in badPayloads)
                await RefusedRequest(V2Frames.Encode(request with { Payload = payload }));
            byte[] good = V2Frames.Encode(request);
            foreach (int index in new[] { 4, 5 })
            {
                byte[] bad = (byte[])good.Clone(); bad[index] = index == 4 ? (byte)1 : (byte)3;
                await RefusedRequest(bad);
            }
            foreach (int length in new[] { 0, 1, 3, 4, 10, good.Length - 1 }) await RefusedRequest(good[..length]);
        });

        await Check("syntax-only checkpoint and authorization failure do not become queries or transactions", async () =>
        {
            var queryStream = new ControlledStream();
            queryStream.Deliver(V2Frames.Encode(new V2Request(1, Id, checkpoint)));
            var query = Server(queryStream, (_, _) => throw new Exception("must not dispatch"));
            await query.Completion.WaitAsync(Budget); await Finish(query);
            Has(query, "CHECKPOINT_QUERY_UNSUPPORTED"); Assert(query.Snapshot().Dispatches == 0);
            var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(request));
            var denied = V2Exchange.StartServer(stream, new TestPolicy { Deny = true },
                (_, _) => throw new Exception("must not dispatch"), Budget, CloseBudget);
            await denied.Completion.WaitAsync(Budget); await Finish(denied);
            Assert(denied.Snapshot().Dispatches == 0 && stream.Writes.Count == 0);
        });

        await Check("all four exact status/commit responses complete without EOF", async () =>
        {
            foreach (var response in responses)
            {
                var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(response));
                var client = Client(stream);
                var outcome = await client.Completion.WaitAsync(Budget);
                Assert(outcome.Kind == "response" && outcome.Response!.Status == response.Status);
                Assert(outcome.Response!.Payload.Span.SequenceEqual(response.Payload.Span));
                Assert(!stream.Disposed && stream.MaxReaders == 1);
                await Finish(client);
            }
        });

        await Check("invalid responses/correlation/reflection cannot fix a business result", async () =>
        {
            byte[] frame = V2Frames.Encode(responses[0]);
            foreach (int index in new[] { 4, 5, 6, 22 })
            {
                byte[] bad = (byte[])frame.Clone(); bad[index] = index == 4 ? (byte)1 : index == 5 ? (byte)1 : (byte)4;
                await UnknownResponse(bad);
            }
            await UnknownResponse(V2Frames.Encode(request));
            await UnknownResponse(frame[..^1]);
            string committed = Encoding.UTF8.GetString(responses[0].Payload.Span);
            foreach (string invalid in new[]
            {
                "{}", committed + " ", committed.Replace("\"confirmed\"", "\"unknown\""),
                committed.Replace("\"executionAuthorized\":false", "\"executionAuthorized\":true"),
                committed.Replace("\"format_version\":1", "\"format_version\":2"),
                committed.Replace("\"development-only\"", "\"production\""),
                committed.Replace("\"status\":\"committed\"", "\"status\":\"unknown\""),
                committed.Replace("\"result\":", "\"code\":\"ERR_TEST\",\"result\":"),
                committed.Replace("\"revision\":2", "\"revision\":3"),
                committed.Replace("\"registered\":true", "\"registered\":false"),
            }) await UnknownResponse(V2Frames.Encode(responses[0] with { Payload = Bytes(invalid) }));
            foreach (var response in responses)
                for (byte status = 0; status < 4; status++)
                    if (status != response.Status) await UnknownResponse(V2Frames.Encode(response with { Status = status }));
        });

        await Check("consume result/permit/checkpoint and issue signature bindings use exact per-action rules", async () =>
        {
            foreach (var pair in new[] { (consume, consumeResponse), (issue, issueUnavailable) })
            {
                var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(pair.Item2));
                var client = V2Exchange.StartClient(stream, new TestPolicy(), pair.Item1, Budget, CloseBudget);
                Assert((await client.Completion.WaitAsync(Budget)).Response!.Status == pair.Item2.Status);
                await Finish(client);
            }
            var wrongPermit = consumeResponse with { Payload = Bytes(Encoding.UTF8.GetString(consumeResponse.Payload.Span)
                .Replace("\"permit-1\"", "\"permit-other\"")) };
            foreach (var pair in new[] { (consume, wrongPermit), (issue, issueInvalidSignature) })
            {
                var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(pair.Item2)); stream.EndInput();
                var client = V2Exchange.StartClient(stream, new TestPolicy(), pair.Item1, Budget, CloseBudget);
                Assert((await client.Completion.WaitAsync(Budget)).Kind == "unknown"); await Finish(client);
            }
        });

        await Check("committed plus same-batch tail preserves the result and marks protocol violation", async () =>
        {
            byte[] frame = V2Frames.Encode(responses[0]);
            foreach (byte[] tail in new[] { new byte[] { 42 }, frame, frame[..8] })
            {
                var stream = new ControlledStream(); stream.Deliver([.. frame, .. tail]);
                var client = Client(stream);
                var result = await client.Completion.WaitAsync(Budget);
                await Finish(client);
                Assert(result.Response!.Status == 0 && client.Snapshot().Outcome.Response!.Status == 0);
                Has(client, "TRAILING_AFTER_RESPONSE");
                var events = client.Snapshot().Events;
                Assert(Array.FindIndex(events, e => e.Code == "BUSINESS_FIXED_RESPONSE") <
                    Array.FindIndex(events, e => e.Code == "TRAILING_AFTER_RESPONSE"));
                Assert(events.Count(e => e.Code.StartsWith("BUSINESS_FIXED_", StringComparison.Ordinal)) == 1);
            }
        });

        await Check("delayed request tail after dispatch requests cancellation; late committed fact is retained separately", async () =>
        {
            var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(request));
            var entered = Signal(); var release = Signal(); CancellationToken execution = default;
            var server = Server(stream, async (_, token) =>
            { execution = token; entered.SetResult(); await release.Task; return responses[0]; });
            await entered.Task.WaitAsync(Budget);
            await Until(() => stream.ReadCalls >= 2);
            stream.Deliver(new byte[] { 0 });
            Assert((await server.Completion.WaitAsync(Budget)).Kind == "unknown");
            await server.FinishAsync();
            Assert(execution.IsCancellationRequested && !server.WhenReleased.IsCompleted);
            release.SetResult(); await server.WhenReleased.WaitAsync(Budget);
            var snapshot = server.Snapshot();
            Assert(snapshot.Outcome.Kind == "unknown" && snapshot.ServerFact!.Status == 0 &&
                snapshot.Dispatches == 1 && stream.Writes.Count == 0);
            Has(server, "TRAILING_AFTER_DISPATCH"); Has(server, "LATE_BUSINESS_RETURN_NO_SEND");
            Save(server);
        });

        await Check("tail after commit while response write is blocked cannot rewrite the executor fact", async () =>
        {
            var stream = new ControlledStream { HoldWrites = true }; stream.Deliver(V2Frames.Encode(request));
            var server = Server(stream, (_, _) => Task.FromResult(responses[0]));
            await stream.WriteEntered.Task.WaitAsync(Budget);
            Assert(server.Snapshot().ServerFact!.Status == 0 && !server.Completion.IsCompleted);
            stream.Deliver(new byte[] { 0 });
            await server.Completion.WaitAsync(Budget); await Finish(server);
            Assert(server.Snapshot().ServerFact!.Status == 0 && server.Snapshot().Outcome.Kind == "unknown");
            Assert(server.Snapshot().Dispatches == 1 && stream.Writes.Count == 0);
        });

        await Check("delayed tails after server send or client acceptance remain diagnostics with no second completion", async () =>
        {
            foreach (bool serverSide in new[] { false, true })
            {
                var stream = new ControlledStream();
                stream.Deliver(serverSide ? V2Frames.Encode(request) : V2Frames.Encode(responses[0]));
                var exchange = serverSide ? Server(stream, (_, _) => Task.FromResult(responses[0])) : Client(stream);
                var original = await exchange.Completion.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                stream.Deliver(V2Frames.Encode(request)[..7]);
                await Until(() => exchange.Snapshot().Events.Any(e => e.Code.StartsWith("TRAILING_", StringComparison.Ordinal)));
                await Finish(exchange);
                Assert(ReferenceEquals(original, await exchange.Completion));
                Assert(exchange.Snapshot().Outcome.Response!.Status == 0 && stream.MaxReaders == 1);
                Assert(exchange.Snapshot().Events.Count(e => e.Code.StartsWith("BUSINESS_FIXED_", StringComparison.Ordinal)) == 1);
            }
        });

        await Check("late cancellation, EOF and cleanup faults never replace an accepted committed response", async () =>
        {
            for (int fault = 0; fault < 3; fault++)
            {
                using var cancel = new CancellationTokenSource();
                var stream = new ControlledStream { ThrowOnDispose = fault == 2 };
                stream.Deliver(V2Frames.Encode(responses[0]));
                var client = V2Exchange.StartClient(stream, new TestPolicy(), request, Budget, CloseBudget, cancel.Token);
                var result = await client.Completion.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                if (fault == 0) cancel.Cancel();
                if (fault == 1)
                {
                    stream.EndInput();
                    await Until(() => client.Snapshot().Events.Any(e => e.Code == "EOF_UNKNOWN_CLOSE"));
                }
                await Finish(client);
                Assert(result.Response!.Status == 0 && client.Snapshot().Outcome.Response!.Status == 0);
                Has(client, "ABORT_UNKNOWN_CLOSE");
                if (fault == 1) Has(client, "EOF_UNKNOWN_CLOSE");
                if (fault == 2) Has(client, "DISPOSE_FAILED");
            }
        });

        await Check("response absent or lost means client unknown; successful local server send is not client evidence", async () =>
        {
            var serverStream = new ControlledStream(); serverStream.Deliver(V2Frames.Encode(request));
            var server = Server(serverStream, (_, _) => Task.FromResult(responses[0]));
            await server.Completion.WaitAsync(Budget); await Finish(server);
            Assert(server.Snapshot().ServerFact!.Status == 0 && server.Snapshot().Responses == 1);
            foreach (byte[] lost in new[] { Array.Empty<byte>(), V2Frames.Encode(responses[0])[..^1] })
                await UnknownResponse(lost);
        });

        await Check("deadline fixes unknown before non-cooperative late response and bounds reader cleanup", async () =>
        {
            var stream = new ControlledStream { IgnoreReadStop = true };
            var client = V2Exchange.StartClient(stream, new TestPolicy(), request,
                TimeSpan.FromMilliseconds(60), TimeSpan.FromMilliseconds(20));
            await Until(() => stream.ReadCalls == 1);
            Assert((await client.Completion.WaitAsync(Budget)).Kind == "unknown");
            await client.FinishAsync().WaitAsync(TimeSpan.FromSeconds(1));
            Assert(!client.WhenReleased.IsCompleted); Has(client, "READER_DID_NOT_EXIT");
            stream.Deliver(V2Frames.Encode(responses[0]));
            await client.WhenReleased.WaitAsync(Budget);
            Assert(client.Snapshot().Outcome.Response is null);
            Has(client, "LATE_READ_IGNORED");
            Assert(!client.Snapshot().Events.Any(e => e.Code == "RESPONSE_VALIDATED"));
            Save(client);
        });

        await Check("slow fragments cannot renew absolute budget; blocked writes and caller cancellation terminate", async () =>
        {
            var stream = new ControlledStream();
            var server = V2Exchange.StartServer(stream, new TestPolicy(), (_, _) => Task.FromResult(responses[0]),
                TimeSpan.FromMilliseconds(70), CloseBudget);
            var timer = Stopwatch.StartNew();
            byte[] frame = V2Frames.Encode(request);
            for (int i = 0; i < 4 && !server.Completion.IsCompleted; i++)
            { stream.Deliver(new byte[] { frame[i] }); await Task.Delay(25); }
            await server.Completion.WaitAsync(Budget); await Finish(server);
            Assert(timer.Elapsed < TimeSpan.FromSeconds(1) && server.Snapshot().Dispatches == 0);
            using var cancel = new CancellationTokenSource();
            var blocked = new ControlledStream { HoldWrites = true };
            var client = V2Exchange.StartClient(blocked, new TestPolicy(), request, Budget, CloseBudget, cancel.Token);
            await blocked.WriteEntered.Task.WaitAsync(Budget); cancel.Cancel();
            Assert((await client.Completion.WaitAsync(Budget)).Kind == "unknown"); await Finish(client);
            Assert(blocked.ReadCalls == 0 && blocked.Writes.Count == 0);
        });

        await Check("monotonic rechecks reject synchronous policy/provider returns past the original deadline", async () =>
        {
            var stream = new ControlledStream();
            var policy = new TestPolicy { OnRequest = () => Thread.Sleep(100) };
            var client = V2Exchange.StartClient(stream, policy, request, TimeSpan.FromMilliseconds(20), CloseBudget);
            Assert((await client.Completion.WaitAsync(Budget)).Kind == "local-not-attempted");
            await Finish(client); Assert(stream.Writes.Count == 0);
            var responseStream = new ControlledStream(); responseStream.Deliver(V2Frames.Encode(responses[0]));
            var slowResponsePolicy = new TestPolicy { OnResponse = () => Thread.Sleep(100) };
            var late = V2Exchange.StartClient(responseStream, slowResponsePolicy, request,
                TimeSpan.FromMilliseconds(20), CloseBudget);
            Assert((await late.Completion.WaitAsync(Budget)).Kind == "unknown");
            await Finish(late);
            Assert(!late.Snapshot().Events.Any(e => e.Code == "RESPONSE_VALIDATED"));
            var serverStream = new ControlledStream(); serverStream.Deliver(V2Frames.Encode(request));
            var server = V2Exchange.StartServer(serverStream, new TestPolicy(), (_, _) =>
            { Thread.Sleep(120); return Task.FromResult(responses[0]); }, TimeSpan.FromMilliseconds(40), CloseBudget);
            await server.Completion.WaitAsync(Budget); await server.FinishAsync();
            await server.WhenReleased.WaitAsync(Budget);
            Assert(server.Snapshot().Outcome.Kind == "unknown" && serverStream.Writes.Count == 0 &&
                server.Snapshot().ServerFact!.Status == 0);
            Save(server);
        });

        await Check("active exchanges have no queue; timed-out providers retain admission until they actually exit", async () =>
        {
            var release = Signal(); var exchanges = new List<V2Exchange>(); var cancels = new List<CancellationTokenSource>();
            for (int i = 0; i < V2Exchange.MaxActive; i++)
            {
                var entered = Signal(); var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(request));
                var cancel = new CancellationTokenSource(); cancels.Add(cancel);
                var server = V2Exchange.StartServer(stream, new TestPolicy(), async (_, _) =>
                { entered.SetResult(); await release.Task; return responses[0]; }, Budget, CloseBudget, cancel.Token);
                exchanges.Add(server); await entered.Task.WaitAsync(Budget);
                cancel.Cancel(); await server.Completion.WaitAsync(Budget); await server.FinishAsync();
                Assert(!server.WhenReleased.IsCompleted);
            }
            using var excess = new ControlledStream();
            Throws<InvalidOperationException>(() => Server(excess, (_, _) => Task.FromResult(responses[0])));
            Assert(excess.ReadCalls == 0 && !excess.Disposed);
            release.SetResult();
            await Task.WhenAll(exchanges.Select(e => e.WhenReleased)).WaitAsync(Budget);
            foreach (var exchange in exchanges) Save(exchange);
            foreach (var cancel in cancels) cancel.Dispose();
            var lastStream = new ControlledStream(); lastStream.Deliver(V2Frames.Encode(request));
            var last = Server(lastStream, (_, _) => Task.FromResult(responses[0]));
            await last.Completion.WaitAsync(Budget); await Finish(last);
        });

        await Check("throwing read cancellation callbacks preserve accepted results and do not exhaust admission", async () =>
        {
            for (int i = 0; i <= V2Exchange.MaxActive; i++)
            {
                var stream = new ControlledStream { ThrowOnReadCancel = true };
                stream.Deliver(V2Frames.Encode(responses[0]));
                var client = Client(stream);
                var result = await client.Completion.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                await Finish(client);
                Assert(stream.Disposed && result.Response!.Status == 0 && client.Snapshot().Outcome.Response!.Status == 0);
                Has(client, "READ_CANCEL_CALLBACK_FAILED");
            }
        });

        await Check("cancellation callback faults retain admission until BOTH reader and worker really exit", async () =>
        {
            var held = new List<(V2Exchange Exchange, ControlledStream Stream, TaskCompletionSource Release)>();
            for (int i = 0; i < V2Exchange.MaxActive; i++)
            {
                var stream = new ControlledStream { IgnoreReadStop = true, ThrowOnReadCancel = true };
                stream.Deliver(V2Frames.Encode(request));
                var entered = Signal(); var release = Signal();
                var server = Server(stream, async (_, token) =>
                {
                    using var registration = token.Register(() => throw new IOException("test executor cancellation failure"));
                    entered.SetResult();
                    await release.Task;
                    return responses[0];
                });
                held.Add((server, stream, release));
                await entered.Task.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                await server.FinishAsync().WaitAsync(Budget);
                var snapshot = server.Snapshot();
                Assert(stream.Disposed && snapshot.Outcome.Kind == "unknown" &&
                    !snapshot.ReaderExited && !snapshot.WorkerExited && !server.WhenReleased.IsCompleted);
                Has(server, "READ_CANCEL_CALLBACK_FAILED"); Has(server, "LIFETIME_CANCEL_CALLBACK_FAILED");
                Has(server, "READER_DID_NOT_EXIT"); Has(server, "ABORT_UNKNOWN_CLOSE");
            }
            using var excess = new ControlledStream();
            Throws<InvalidOperationException>(() => Server(excess, (_, _) => Task.FromResult(responses[0])));
            // Half exit reader-first, half worker-first; neither alone releases a slot.
            for (int i = 0; i < held.Count; i++)
            {
                var item = held[i];
                if (i % 2 == 0) item.Stream.EndInput(); else item.Release.SetResult();
                await Until(() => i % 2 == 0 ? item.Exchange.Snapshot().ReaderExited : item.Exchange.Snapshot().WorkerExited);
                Assert(!item.Exchange.WhenReleased.IsCompleted);
            }
            Throws<InvalidOperationException>(() => Server(excess, (_, _) => Task.FromResult(responses[0])));
            for (int i = 0; i < held.Count; i++)
            {
                if (i % 2 == 0) held[i].Release.SetResult(); else held[i].Stream.EndInput();
                await Finish(held[i].Exchange);
                Assert(held[i].Exchange.Snapshot().ServerFact!.Status == 0 && held[i].Stream.Writes.Count == 0);
            }
            var recoveredStream = new ControlledStream(); recoveredStream.Deliver(V2Frames.Encode(request));
            var recovered = Server(recoveredStream, (_, _) => Task.FromResult(responses[0]));
            await recovered.Completion.WaitAsync(Budget); await Finish(recovered);
        });

        await Check("deadline and caller cancellation contain executor callback faults and continue cleanup", async () =>
        {
            foreach (bool deadline in new[] { false, true })
            {
                using var cancel = new CancellationTokenSource();
                var entered = Signal(); var release = Signal();
                var stream = new ControlledStream { ThrowOnReadCancel = true };
                stream.Deliver(V2Frames.Encode(request));
                var server = V2Exchange.StartServer(stream, new TestPolicy(), async (_, token) =>
                {
                    using var registration = token.Register(() => throw new IOException("test executor cancellation failure"));
                    entered.SetResult();
                    await release.Task;
                    return responses[0];
                }, deadline ? TimeSpan.FromMilliseconds(200) : Budget, CloseBudget, cancel.Token);
                await entered.Task.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                if (!deadline) cancel.Cancel();
                Assert((await server.Completion.WaitAsync(Budget)).Kind == "unknown");
                await server.FinishAsync().WaitAsync(Budget);
                Has(server, "READ_CANCEL_CALLBACK_FAILED"); Has(server, "LIFETIME_CANCEL_CALLBACK_FAILED");
                await Until(() => server.Snapshot().ReaderExited);
                Assert(stream.Disposed && !server.WhenReleased.IsCompleted);
                release.SetResult();
                await Finish(server);
                Assert(server.Snapshot().ServerFact!.Status == 0 && stream.Writes.Count == 0);
            }
        });

        await Check("guarded deadline/caller cancellation still reaches a synchronous executor", async () =>
        {
            foreach (bool deadline in new[] { false, true })
            {
                using var cancel = new CancellationTokenSource();
                using var callbackInvoked = new ManualResetEventSlim();
                var entered = Signal();
                var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(request));
                var server = V2Exchange.StartServer(stream, new TestPolicy(), (_, token) =>
                {
                    using var registration = token.Register(() =>
                    {
                        callbackInvoked.Set();
                        throw new IOException("test executor cancellation failure");
                    });
                    entered.SetResult();
                    if (!token.WaitHandle.WaitOne(Budget)) throw new Exception("executor never received cancellation");
                    if (!callbackInvoked.Wait(Budget)) throw new Exception("executor callback never ran");
                    return Task.FromResult(responses[0]);
                }, deadline ? TimeSpan.FromMilliseconds(200) : Budget, CloseBudget, cancel.Token);
                await entered.Task.WaitAsync(Budget);
                if (!deadline) cancel.Cancel();
                Assert((await server.Completion.WaitAsync(TimeSpan.FromSeconds(2))).Kind == "unknown");
                await Finish(server);
                Has(server, "LIFETIME_CANCEL_CALLBACK_FAILED");
                Assert(server.Snapshot().ServerFact!.Status == 0 && stream.Writes.Count == 0);
            }
        });

        await Check("cleanup is published once before reentrant callbacks; callbacks can await cross-thread Snapshot", async () =>
        {
            var failures = new List<string>();
            foreach (string hook in new[] { "read-cancel", "dispose" })
            {
                V2Exchange client = null!; Task? reentered = null; bool snapshotAvailable = false;
                int calls = 0;
                void Callback()
                {
                    if (Interlocked.Increment(ref calls) != 1) return;
                    snapshotAvailable = SnapshotFromThread(client);
                    reentered = client.FinishAsync();
                }
                var stream = new ControlledStream();
                if (hook == "read-cancel") stream.OnReadCancel = Callback; else stream.OnDispose = Callback;
                stream.Deliver(V2Frames.Encode(responses[0]));
                client = Client(stream);
                await client.Completion.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                Task first = client.FinishAsync();
                await first.WaitAsync(Budget);
                await client.WhenReleased.WaitAsync(Budget);
                bool single = ReferenceEquals(first, reentered) && ReferenceEquals(first, client.FinishAsync()) &&
                    stream.DisposeCalls == 1 && client.Snapshot().Events.Count(e => e.Code == "READER_CLOSING") == 1;
                Console.WriteLine($"REENTRY {hook}: Snapshot={snapshotAvailable}, singleCleanup={single}, DisposeCalls={stream.DisposeCalls}");
                if (!snapshotAvailable || !single) failures.Add(hook);
            }

            // An executor failure triggers Terminate while the sole reader is
            // pending. Keep its lifetime callback registered through cleanup.
            {
                V2Exchange server = null!; Task? readReentry = null; Task? workerReentry = null;
                bool readSnapshot = false; bool workerSnapshot = false;
                var entered = Signal(); var fail = Signal();
                CancellationTokenRegistration executionRegistration = default;
                var stream = new ControlledStream { OnReadCancel = () =>
                {
                    readSnapshot = SnapshotFromThread(server);
                    readReentry = server.FinishAsync();
                } };
                stream.Deliver(V2Frames.Encode(request));
                server = Server(stream, async (_, token) =>
                {
                    executionRegistration = token.Register(() =>
                    {
                        workerSnapshot = SnapshotFromThread(server);
                        workerReentry = server.FinishAsync();
                    });
                    entered.SetResult(); await fail.Task;
                    throw new IOException("test executor failure triggers Terminate with a pending reader");
                });
                await entered.Task.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                fail.SetResult();
                await server.Completion.WaitAsync(Budget);
                Task first = server.FinishAsync();
                await first.WaitAsync(Budget);
                await server.WhenReleased.WaitAsync(Budget);
                executionRegistration.Dispose();
                bool single = ReferenceEquals(first, readReentry) && ReferenceEquals(first, workerReentry) &&
                    stream.DisposeCalls == 1 && server.Snapshot().Events.Count(e => e.Code == "READER_CLOSING") == 1;
                Console.WriteLine($"REENTRY terminate/lifetime: readSnapshot={readSnapshot}, workerSnapshot={workerSnapshot}, singleCleanup={single}");
                if (!readSnapshot || !workerSnapshot || !single) failures.Add("terminate/lifetime");
            }
            Assert(failures.Count == 0);
        });

        await Check("policy, dispatch and stream callbacks can synchronously wait for cross-thread Snapshot", async () =>
        {
            V2Exchange server = null!;
            var observed = new ConcurrentDictionary<string, bool>();
            void Observe(string name) => observed[name] = SnapshotFromThread(server);
            var policy = new TestPolicy { OnRequest = () => Observe("request"),
                OnAuthorize = () => Observe("authorize"), OnResponse = () => Observe("response") };
            var stream = new ControlledStream();
            server = V2Exchange.StartServer(stream, policy, (_, _) =>
            { Observe("dispatch"); return Task.FromResult(responses[0]); }, Budget, CloseBudget);
            stream.OnRead = () => Observe("read");
            stream.OnWrite = () => Observe("write");
            stream.OnFlush = () => Observe("flush");
            stream.OnDispose = () => Observe("dispose");
            stream.Deliver(V2Frames.Encode(request));
            Assert((await server.Completion.WaitAsync(Budget)).Kind == "server-result");
            await Until(() => stream.ReadCalls >= 2);
            await Finish(server);
            foreach (string name in new[] { "request", "authorize", "response", "dispatch", "read", "write", "flush", "dispose" })
                Assert(observed.TryGetValue(name, out bool available) && available);
            Assert(stream.MaxReaders == 1 && server.Snapshot().Dispatches == 1);
        });

        await Check("blocking cleanup callbacks retain admission after reader and worker exit", async () =>
        {
            var held = new List<(V2Exchange Exchange, ControlledStream Stream, Task Cleanup, TaskCompletionSource Release)>();
            for (int i = 0; i < V2Exchange.MaxActive; i++)
            {
                var entered = Signal(); var release = Signal();
                var stream = new ControlledStream { OnDispose = () =>
                { entered.SetResult(); release.Task.GetAwaiter().GetResult(); } };
                stream.Deliver(V2Frames.Encode(responses[0]));
                var client = Client(stream);
                await client.Completion.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                Task cleanup = client.FinishAsync();
                held.Add((client, stream, cleanup, release));
                await entered.Task.WaitAsync(Budget);
                var concurrent = new Task[4];
                await Task.WhenAll(Enumerable.Range(0, concurrent.Length).Select(index => Task.Run(() =>
                { concurrent[index] = client.FinishAsync(); })));
                Assert(concurrent.All(task => ReferenceEquals(task, cleanup)));
                await Until(() => client.Snapshot().ReaderExited && client.Snapshot().WorkerExited);
                Assert(!cleanup.IsCompleted && !client.WhenReleased.IsCompleted &&
                    ReferenceEquals(cleanup, client.FinishAsync()));
            }
            using var excess = new ControlledStream();
            Throws<InvalidOperationException>(() => Client(excess));
            foreach (var item in held)
            {
                item.Release.SetResult();
                await item.Cleanup.WaitAsync(Budget);
                await item.Exchange.WhenReleased.WaitAsync(Budget);
                Assert(item.Stream.DisposeCalls == 1 && item.Exchange.Snapshot().Outcome.Response!.Status == 0);
                Save(item.Exchange);
            }
            var recovered = new ControlledStream(); recovered.Deliver(V2Frames.Encode(responses[0]));
            var exchange = Client(recovered); await exchange.Completion.WaitAsync(Budget); await Finish(exchange);
        });

        await Check("policy and executor reentry cannot dispatch or send new work after closing", async () =>
        {
            foreach (string hook in new[] { "authorize", "dispatch", "response" })
            {
                V2Exchange server = null!; Task? reentered = null;
                var stream = new ControlledStream();
                var policy = new TestPolicy { OnAuthorize = () =>
                { if (hook == "authorize") reentered = server.FinishAsync(); }, OnResponse = () =>
                { if (hook == "response") reentered = server.FinishAsync(); } };
                server = V2Exchange.StartServer(stream, policy, (_, _) =>
                {
                    if (hook == "dispatch") reentered = server.FinishAsync();
                    return Task.FromResult(responses[0]);
                }, Budget, CloseBudget);
                stream.Deliver(V2Frames.Encode(request));
                await server.Completion.WaitAsync(Budget);
                await Finish(server);
                var snapshot = server.Snapshot();
                Assert(ReferenceEquals(reentered, server.FinishAsync()) && stream.Writes.Count == 0 && stream.DisposeCalls == 1);
                Assert(snapshot.Dispatches == (hook == "authorize" ? 0 : 1));
                Assert(hook == "authorize" ? snapshot.ServerFact is null : snapshot.ServerFact!.Status == 0);
            }
        });

        await Check("lifetime/read cancellation callbacks do not block independent reader stop or disposal", async () =>
        {
            var failures = new List<string>();
            foreach (bool lifetimeWaitsForReader in new[] { true, false })
            {
                var entered = Signal(); var callbackEntered = Signal(); var dependencyCompleted = Signal();
                var releaseWorker = Signal();
                CancellationTokenRegistration registration = default;
                var stream = new ControlledStream();
                void Callback()
                {
                    callbackEntered.TrySetResult();
                    dependencyCompleted.Task.GetAwaiter().GetResult();
                }
                if (!lifetimeWaitsForReader)
                {
                    stream.OnReadCancel = Callback;
                    // Keep the pending registration alive until CancelAsync
                    // actually enters it; disposal must not win that race.
                    stream.OnDispose = () => callbackEntered.Task.GetAwaiter().GetResult();
                }
                stream.Deliver(V2Frames.Encode(request));
                var server = Server(stream, async (_, token) =>
                {
                    if (lifetimeWaitsForReader) registration = token.Register(Callback);
                    entered.SetResult(); await releaseWorker.Task; return responses[0];
                });
                await entered.Task.WaitAsync(Budget);
                await Until(() => stream.ReadCalls >= 2);
                Task cleanup = server.FinishAsync();
                await callbackEntered.Task.WaitAsync(Budget);
                bool progressed;
                try
                {
                    await Until(() => lifetimeWaitsForReader ? server.Snapshot().ReaderExited : stream.Disposed)
                        .WaitAsync(TimeSpan.FromSeconds(1));
                    progressed = true;
                }
                catch (TimeoutException) { progressed = false; }
                // The escape barrier lets the broken implementation terminate
                // after recording the cycle, without leaving a hung test process.
                dependencyCompleted.SetResult();
                await cleanup.WaitAsync(Budget);
                Assert(!server.WhenReleased.IsCompleted);
                releaseWorker.SetResult(); await Finish(server); registration.Dispose();
                Console.WriteLine($"CANCEL_DEPENDENCY {(lifetimeWaitsForReader ? "lifetime->reader" : "read->dispose")}: progressed={progressed}");
                if (!progressed) failures.Add(lifetimeWaitsForReader ? "lifetime->reader" : "read->dispose");
            }
            Assert(failures.Count == 0);
        });

        await Check("pending synchronous cancellation callbacks retain admission after reader and worker exit", async () =>
        {
            var held = new List<(V2Exchange Exchange, Task Cleanup, TaskCompletionSource ReleaseLifetime,
                TaskCompletionSource ReleaseRead, CancellationTokenRegistration Registration)>();
            for (int i = 0; i < V2Exchange.MaxActive; i++)
            {
                var entered = Signal(); var releaseWorker = Signal();
                var lifetimeEntered = Signal(); var readEntered = Signal();
                var releaseLifetime = Signal(); var releaseRead = Signal();
                CancellationTokenRegistration registration = default;
                var stream = new ControlledStream { DetachReadRegistration = true,
                    OnDispose = () => readEntered.Task.GetAwaiter().GetResult(), OnReadCancel = () =>
                {
                    readEntered.SetResult(); releaseRead.Task.GetAwaiter().GetResult();
                    throw new IOException("test delayed read callback failure");
                } };
                stream.Deliver(V2Frames.Encode(request));
                var server = Server(stream, async (_, token) =>
                {
                    registration = token.Register(() =>
                    {
                        lifetimeEntered.SetResult(); releaseLifetime.Task.GetAwaiter().GetResult();
                        throw new IOException("test delayed lifetime callback failure");
                    });
                    entered.SetResult(); await releaseWorker.Task; return responses[0];
                });
                await entered.Task.WaitAsync(Budget); await Until(() => stream.ReadCalls >= 2);
                Task cleanup = server.FinishAsync();
                held.Add((server, cleanup, releaseLifetime, releaseRead, registration));
                await Task.WhenAll(lifetimeEntered.Task, readEntered.Task).WaitAsync(Budget);
                // This backend unregisters without waiting for callbacks. Both
                // read and executor can exit while BOTH cancellation tasks live.
                releaseWorker.SetResult();
                await Until(() => server.Snapshot().ReaderExited && server.Snapshot().WorkerExited);
                Assert(stream.Disposed && !server.WhenReleased.IsCompleted && !cleanup.IsCompleted);
            }
            using var excess = new ControlledStream();
            Throws<InvalidOperationException>(() => Client(excess));
            for (int i = 0; i < held.Count; i++)
            {
                // Release one callback only, in both orders. Either remaining
                // cancellation task must independently keep admission occupied.
                if (i % 2 == 0) held[i].ReleaseLifetime.SetResult(); else held[i].ReleaseRead.SetResult();
                string diagnostic = i % 2 == 0 ? "LIFETIME_CANCEL_CALLBACK_FAILED" : "READ_CANCEL_CALLBACK_FAILED";
                await Until(() => held[i].Exchange.Snapshot().Events.Any(e => e.Code == diagnostic));
                Assert(!held[i].Cleanup.IsCompleted && !held[i].Exchange.WhenReleased.IsCompleted);
            }
            Throws<InvalidOperationException>(() => Client(excess));
            foreach (var item in held)
            {
                item.ReleaseLifetime.TrySetResult(); item.ReleaseRead.TrySetResult();
                await item.Cleanup.WaitAsync(Budget); await Finish(item.Exchange);
                item.Registration.Dispose();
            }
            var streamAfter = new ControlledStream(); streamAfter.Deliver(V2Frames.Encode(responses[0]));
            var after = Client(streamAfter); await after.Completion.WaitAsync(Budget); await Finish(after);
        });

        await Check("contract violation example: async void cancellation tails are NOT tracked or intercepted", async () =>
        {
            // Deliberately forbidden integration, documenting the runtime limit.
            // No post-await exception or side effect: the test explicitly joins
            // its escaped tail in finally; production must NEVER use this pattern.
            var callbackEntered = Signal(); var releaseTail = Signal(); var tailExited = Signal();
            CancellationTokenRegistration registration = default;
            var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(request));
            var server = Server(stream, (_, token) =>
            {
                registration = token.Register(async () =>
                {
                    callbackEntered.SetResult();
                    await releaseTail.Task;
                    tailExited.SetResult();
                }); // Action is async void; CancelAsync cannot join its await tail.
                return Task.FromResult(responses[0]);
            });
            try
            {
                await server.Completion.WaitAsync(Budget);
                await Finish(server);
                await callbackEntered.Task.WaitAsync(Budget);
                Assert(server.WhenReleased.IsCompleted && !tailExited.Task.IsCompleted);
                Console.WriteLine("CONTRACT_LIMIT async void tail outlives WhenReleased; no runtime enforcement claimed");
            }
            finally
            {
                releaseTail.TrySetResult();
                await tailExited.Task.WaitAsync(Budget);
                registration.Dispose();
            }
        });

        await Check("trusted executor example: synchronous signal plus awaited async finally retains admission", async () =>
        {
            var held = new List<(V2Exchange Exchange, TaskCompletionSource ReleaseCleanup, TaskCompletionSource CleanupExited)>();
            for (int i = 0; i < V2Exchange.MaxActive; i++)
            {
                var entered = Signal(); var canceled = Signal(); var cleanupEntered = Signal();
                var releaseCleanup = Signal(); var cleanupExited = Signal();
                var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(request));
                var server = Server(stream, async (_, token) =>
                {
                    // Recommended: Register only signals. The returned executor
                    // Task owns every async continuation, including cleanup.
                    using var registration = token.Register(() => canceled.TrySetResult());
                    entered.SetResult();
                    try
                    {
                        await canceled.Task;
                        token.ThrowIfCancellationRequested();
                        return responses[0];
                    }
                    finally
                    {
                        cleanupEntered.SetResult();
                        await releaseCleanup.Task;
                        cleanupExited.SetResult();
                    }
                });
                held.Add((server, releaseCleanup, cleanupExited));
                await entered.Task.WaitAsync(Budget);
                await server.FinishAsync().WaitAsync(Budget);
                await cleanupEntered.Task.WaitAsync(Budget);
                var snapshot = server.Snapshot();
                Assert(snapshot.ReaderExited && !snapshot.WorkerExited && !cleanupExited.Task.IsCompleted &&
                    !server.WhenReleased.IsCompleted && snapshot.Outcome.Kind == "unknown" && stream.Writes.Count == 0);
            }
            using var excess = new ControlledStream();
            Throws<InvalidOperationException>(() => Client(excess));
            foreach (var item in held)
            {
                item.ReleaseCleanup.SetResult();
                await Finish(item.Exchange);
                Assert(item.CleanupExited.Task.IsCompleted && item.Exchange.Snapshot().ServerFact is null);
            }
            var recovered = new ControlledStream(); recovered.Deliver(V2Frames.Encode(responses[0]));
            var client = Client(recovered); await client.Completion.WaitAsync(Budget); await Finish(client);
        });

        await Check("caller payloads and exposed completion buffers cannot mutate retained results", async () =>
        {
            var stream = new ControlledStream(); stream.Deliver(V2Frames.Encode(responses[0]));
            byte[] original = request.Payload.ToArray();
            var client = V2Exchange.StartClient(stream, new TestPolicy(), request with { Payload = original }, Budget, CloseBudget);
            original[0] = 0;
            var result = await client.Completion.WaitAsync(Budget);
            if (!MemoryMarshal.TryGetArray(result.Response!.Payload, out ArraySegment<byte> storage)) throw new Exception("array expected");
            storage.Array![storage.Offset] = 0;
            Assert(client.Snapshot().Outcome.Response!.Payload.Span[0] == 0x7b);
            await Finish(client);
            Assert(PermitWitness.Windows.Program.Refuse([]) == (OperatingSystem.IsWindows() ? 78 : 69));
            Assert(PermitWitness.Windows.Program.Refuse(["--v2=true"]) == 64);
        });

        Console.WriteLine($"PASS {passed} v2 groups; controlled streams + original-byte JS offline policy only; " +
            $"OS={System.Runtime.InteropServices.RuntimeInformation.OSDescription}; TLS=NOT_EXERCISED; Windows Schannel=NOT_VERIFIED");
    }

    private static V2Exchange Client(ControlledStream stream) =>
        V2Exchange.StartClient(stream, new TestPolicy(), request, Budget, CloseBudget);
    private static V2Exchange Server(ControlledStream stream, Func<V2Request, CancellationToken, Task<V2Response>> dispatch) =>
        V2Exchange.StartServer(stream, new TestPolicy(), dispatch, Budget, CloseBudget);

    private static async Task RefusedRequest(byte[] bytes)
    {
        var stream = new ControlledStream(); stream.Deliver(bytes); stream.EndInput();
        int calls = 0;
        var server = Server(stream, (_, _) => { calls++; return Task.FromResult(responses[0]); });
        await server.Completion.WaitAsync(Budget); await Finish(server);
        Assert(calls == 0 && server.Snapshot().Dispatches == 0 && stream.Writes.Count == 0);
    }

    private static async Task UnknownResponse(byte[] bytes)
    {
        var stream = new ControlledStream(); stream.Deliver(bytes); stream.EndInput();
        var client = Client(stream);
        Assert((await client.Completion.WaitAsync(Budget)).Kind == "unknown");
        await Finish(client); Assert(client.Snapshot().Outcome.Response is null);
    }

    private static async Task Finish(V2Exchange exchange)
    {
        await exchange.FinishAsync().WaitAsync(Budget);
        await exchange.WhenReleased.WaitAsync(Budget);
        var snapshot = exchange.Snapshot();
        Assert(snapshot.ReaderExited && snapshot.WorkerExited);
        Assert(snapshot.Events.Select(e => e.Sequence).SequenceEqual(Enumerable.Range(1, snapshot.Events.Length).Select(n => (long)n)));
        Assert(snapshot.Events.Zip(snapshot.Events.Skip(1)).All(pair => pair.First.ElapsedTicks <= pair.Second.ElapsedTicks));
        Has(exchange, "ABORT_UNKNOWN_CLOSE");
        Save(exchange);
    }

    private static void Save(V2Exchange exchange)
    {
        string? directory = Environment.GetEnvironmentVariable("V2_TEST_EVENT_DIR");
        if (directory is null) return;
        string root = Path.GetFullPath(".agent/runtime") + Path.DirectorySeparatorChar;
        directory = Path.GetFullPath(directory);
        if (!directory.StartsWith(root, StringComparison.Ordinal)) throw new Exception("evidence must stay under .agent/runtime");
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, $"exchange-{Interlocked.Increment(ref evidence):D4}.json");
        using var output = new FileStream(path, FileMode.CreateNew);
        // Record classifications/timing only, no payload, credentials or identity labels.
        var snapshot = exchange.Snapshot();
        JsonSerializer.Serialize(output, new { snapshot.Outcome.Kind, ResponseStatus = snapshot.Outcome.Response?.Status,
            ServerFactStatus = snapshot.ServerFact?.Status, snapshot.Dispatches, snapshot.Responses,
            snapshot.ReaderExited, snapshot.WorkerExited, snapshot.Events, StopwatchFrequency = Stopwatch.Frequency });
    }

    private static void Has(V2Exchange exchange, string code) => Assert(exchange.Snapshot().Events.Any(e => e.Code == code));
    private static async Task Until(Func<bool> condition)
    {
        using var stop = new CancellationTokenSource(Budget);
        while (!condition()) await Task.Delay(1, stop.Token);
    }
    // A bounded wait makes the old lock cycle fail without hanging the harness.
    // The independent thread signals BEFORE trying Snapshot; no random sleeps.
    private static bool SnapshotFromThread(V2Exchange exchange)
    {
        using var attempting = new ManualResetEventSlim();
        var completed = Signal();
        var thread = new Thread(() =>
        {
            attempting.Set();
            exchange.Snapshot();
            completed.TrySetResult();
        }) { IsBackground = true };
        thread.Start();
        Assert(attempting.Wait(Budget));
        return completed.Task.Wait(TimeSpan.FromSeconds(1));
    }
    private static async Task Check(string name, Func<Task> body)
    { await body(); passed++; Console.WriteLine("PASS v2 " + name); }
    private static void Assert(bool condition)
    { if (!condition) throw new Exception("v2 assertion failed"); }
    private static void Throws<T>(Action body) where T : Exception
    { try { body(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
    private static async Task ThrowsAsync<T>(Func<Task> body) where T : Exception
    { try { await body(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }

    private static string Node(object input)
    {
        var options = new ProcessStartInfo("node")
        { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        // Resolve the oracle next to this test file so the harness does not
        // depend on the caller's working directory.
        var oracle = FindOracle();
        options.ArgumentList.Add(oracle);
        using var process = Process.Start(options) ?? throw new Exception("test oracle unavailable");
        process.StandardInput.Write(JsonSerializer.Serialize(input)); process.StandardInput.Close();
        string output = process.StandardOutput.ReadToEnd();
        if (!process.WaitForExit(10000)) { process.Kill(entireProcessTree: true); throw new Exception("test oracle timed out"); }
        if (process.ExitCode != 0) throw new ProtocolException();
        return output;
    }

    // The oracle is a repository fixture that requires the sibling
    // lib/coordination modules by relative path. Resolve it from the
    // repository root instead of the build output directory, and never from
    // the caller's working directory.
    private static string FindOracle()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "packages", "permit-witness-windows",
                "tests", "v2_payload_policy.js");
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }
        throw new Exception("test oracle unavailable");
    }

    private sealed class TestPolicy : IV2PayloadPolicy
    {
        private static readonly ConcurrentDictionary<string, bool> Valid = new();
        internal Action? OnRequest { get; init; }
        internal Action? OnResponse { get; init; }
        internal Action? OnAuthorize { get; init; }
        internal bool Deny { get; init; }
        public void ValidateRequest(V2Request request)
        {
            OnRequest?.Invoke();
            string hex = Convert.ToHexString(V2Frames.Encode(request));
            if (!Valid.ContainsKey(hex)) { Node(new { request = hex }); Valid[hex] = true; }
        }
        public void AuthorizeRequest(V2Request request)
        { OnAuthorize?.Invoke(); if (Deny) throw new ProtocolException(); } // Test-owned peer binding; not TLS identity evidence.
        public void ValidateResponse(V2Request request, V2Response response)
        {
            OnResponse?.Invoke();
            string req = Convert.ToHexString(V2Frames.Encode(request));
            string res = Convert.ToHexString(V2Frames.Encode(response));
            string key = req + ":" + res;
            if (!Valid.ContainsKey(key)) { Node(new { request = req, response = res }); Valid[key] = true; }
        }
    }

    private sealed class ControlledStream : Stream
    {
        private readonly Channel<byte[]> input = Channel.CreateUnbounded<byte[]>(); // TEST input only.
        private byte[] current = [];
        private int offset;
        private int activeReaders;
        private int maxReaders;
        private int readCalls;
        private readonly TaskCompletionSource readCancelEntered = Signal();
        internal int ReadCalls => Volatile.Read(ref readCalls);
        internal int MaxReaders => Volatile.Read(ref maxReaders);
        internal bool Disposed { get; private set; }
        internal bool HoldWrites { get; init; }
        internal bool IgnoreReadStop { get; init; }
        internal bool ThrowOnReadCancel { get; init; }
        internal bool DetachReadRegistration { get; init; }
        internal bool ThrowOnDispose { get; init; }
        internal Action? OnReadCancel { get; set; }
        internal Action? OnDispose { get; set; }
        internal Action? OnRead { get; set; }
        internal Action? OnWrite { get; set; }
        internal Action? OnFlush { get; set; }
        private int disposeCalls;
        internal int DisposeCalls => Volatile.Read(ref disposeCalls);
        internal ControlledStream? Peer { get; set; }
        internal ConcurrentQueue<byte[]> Writes { get; } = new();
        internal TaskCompletionSource WriteEntered { get; } = Signal();
        internal void Deliver(byte[] bytes) { if (bytes.Length != 0) input.Writer.TryWrite((byte[])bytes.Clone()); }
        internal void EndInput() => input.Writer.TryComplete();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            OnRead?.Invoke();
            var registration = ThrowOnReadCancel || OnReadCancel is not null
                ? cancellationToken.Register(() =>
                {
                    readCancelEntered.TrySetResult();
                    // This callback alone releases a cooperative read, so read
                    // completion cannot deregister the fault before it runs.
                    OnReadCancel?.Invoke();
                    if (!IgnoreReadStop) input.Writer.TryComplete();
                    if (ThrowOnReadCancel) throw new IOException("test read cancellation failure");
                }) : default;
            int active = Interlocked.Increment(ref activeReaders);
            if (active > maxReaders) Volatile.Write(ref maxReaders, active);
            Interlocked.Increment(ref readCalls);
            try
            {
                if (offset == current.Length)
                {
                    try { current = await input.Reader.ReadAsync(IgnoreReadStop || ThrowOnReadCancel || OnReadCancel is not null ? default : cancellationToken); offset = 0; }
                    catch (ChannelClosedException) { return 0; }
                }
                int count = Math.Min(buffer.Length, current.Length - offset);
                current.AsMemory(offset, count).CopyTo(buffer); offset += count;
                return count;
            }
            finally
            {
                Interlocked.Decrement(ref activeReaders);
                if (DetachReadRegistration) registration.Unregister(); else registration.Dispose();
            }
        }
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            OnWrite?.Invoke();
            WriteEntered.TrySetResult();
            if (HoldWrites) await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            byte[] copy = buffer.ToArray(); Writes.Enqueue(copy); Peer?.Deliver(copy);
        }
        public override Task FlushAsync(CancellationToken cancellationToken)
        { OnFlush?.Invoke(); return Task.CompletedTask; }
        protected override void Dispose(bool disposing)
        {
            Interlocked.Increment(ref disposeCalls);
            OnDispose?.Invoke();
            // Fault/reentry tests require the injected callback to actually run.
            // Do not let disposal unregister it before CancelAsync schedules it.
            if (Volatile.Read(ref activeReaders) != 0 && (ThrowOnReadCancel || OnReadCancel is not null) &&
                !readCancelEntered.Task.Wait(Budget)) throw new IOException("test read callback never entered");
            Disposed = true;
            if (!IgnoreReadStop) input.Writer.TryComplete();
            if (ThrowOnDispose) throw new IOException("test dispose failure");
            base.Dispose(disposing);
        }
        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}

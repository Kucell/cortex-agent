using System.Buffers.Binary;

namespace PermitWitness.Windows;

internal sealed class ProtocolException : IOException
{
    internal ProtocolException() : base("ERR_IPC_PROTOCOL") { }
}

// Binary framing is neither authentication nor business authorization.
// The executable is disabled and the older transport wiring below stays closed.
internal static class Frames
{
    internal const int MaxPayload = 1_048_576;
    internal const int HeaderSize = 18; // version, operation, RFC 4122 UUID
    internal const int MaxBytes = HeaderSize + MaxPayload + 1;
    private const byte Version = 1;

    internal static byte[] EncodeRequest(byte operation, Guid requestId, ReadOnlySpan<byte> payload) =>
        Encode(operation, requestId, null, payload);

    internal static byte[] EncodeResponse(byte operation, Guid requestId, byte status, ReadOnlySpan<byte> payload) =>
        Encode(operation, requestId, status, payload);

    private static byte[] Encode(byte operation, Guid requestId, byte? status, ReadOnlySpan<byte> payload)
    {
        if (operation is not (1 or 2) || payload.IsEmpty || payload.Length > MaxPayload || status > 3 ||
            (!status.HasValue && payload[0] != 0x7b))
            throw new ProtocolException();
        int size = HeaderSize + payload.Length + (status.HasValue ? 1 : 0);
        var frame = new byte[4 + size];
        BinaryPrimitives.WriteUInt32BigEndian(frame, (uint)size);
        frame[4] = Version;
        frame[5] = operation;
        if (!requestId.TryWriteBytes(frame.AsSpan(6, 16), bigEndian: true, out int written) || written != 16)
            throw new ProtocolException();
        int offset = 22;
        if (status.HasValue) frame[offset++] = status.Value;
        payload.CopyTo(frame.AsSpan(offset));
        return frame;
    }

    internal static async Task WriteRequestAsync(Stream stream, byte operation, Guid requestId,
        ReadOnlyMemory<byte> payload, CancellationToken cancellation)
    {
        byte[] frame = EncodeRequest(operation, requestId, payload.Span);
        await stream.WriteAsync(frame, cancellation);
        await stream.FlushAsync(cancellation);
    }

    internal static async Task WriteResponseAsync(Stream stream, byte operation, Guid requestId,
        byte status, ReadOnlyMemory<byte> payload, CancellationToken cancellation)
    {
        byte[] frame = EncodeResponse(operation, requestId, status, payload.Span);
        await stream.WriteAsync(frame, cancellation);
        await stream.FlushAsync(cancellation);
    }

    internal static async Task<CandidateRequest> ReadRequestAsync(Stream stream, CancellationToken cancellation)
    {
        byte[] body = await ReadBodyAsync(stream, response: false, cancellation);
        ValidateHeader(body);
        if (body[HeaderSize] != 0x7b) throw new ProtocolException();
        await RequireEofAsync(stream, cancellation);
        return new CandidateRequest(body[1], new Guid(body.AsSpan(2, 16), bigEndian: true), body[HeaderSize..]);
    }

    // The host must pass the exact sent request payload and keep it immutable.
    // Requests start with '{', which is outside the valid response statuses.
    // This checks only the first byte, not JSON syntax or business schema.
    // EOF is required; the host must bound the wait.
    internal static async Task<CandidateResponse> ReadResponseAsync(Stream stream, byte expectedOperation,
        Guid expectedId, ReadOnlyMemory<byte> sentRequestPayload, CancellationToken cancellation)
    {
        if (expectedOperation is not (1 or 2) || sentRequestPayload.IsEmpty || sentRequestPayload.Length > MaxPayload ||
            sentRequestPayload.Span[0] != 0x7b)
            throw new ProtocolException();
        byte[] body = await ReadBodyAsync(stream, response: true, cancellation);
        ValidateHeader(body);
        var requestId = new Guid(body.AsSpan(2, 16), bigEndian: true);
        if (body[1] != expectedOperation || requestId != expectedId || body[HeaderSize] > 3 ||
            body.AsSpan(HeaderSize).SequenceEqual(sentRequestPayload.Span))
            throw new ProtocolException();
        await RequireEofAsync(stream, cancellation);
        return new CandidateResponse(body[1], requestId, body[HeaderSize], body[(HeaderSize + 1)..]);
    }

    private static async Task RequireEofAsync(Stream stream, CancellationToken cancellation)
    {
        var extra = new byte[1];
        cancellation.ThrowIfCancellationRequested();
        if (await stream.ReadAsync(extra, cancellation) != 0) throw new ProtocolException();
        cancellation.ThrowIfCancellationRequested();
    }

    private static void ValidateHeader(byte[] body)
    {
        if (body[0] != Version || body[1] is not (1 or 2)) throw new ProtocolException();
    }

    private static async Task<byte[]> ReadBodyAsync(Stream stream, bool response, CancellationToken cancellation)
    {
        var header = new byte[4];
        await ReadExactlyAsync(stream, header, cancellation);
        uint size = BinaryPrimitives.ReadUInt32BigEndian(header);
        int extra = response ? 1 : 0;
        if (size < HeaderSize + extra + 1 || size > HeaderSize + extra + MaxPayload)
            throw new ProtocolException();
        var body = new byte[(int)size];
        await ReadExactlyAsync(stream, body, cancellation);
        return body;
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> buffer, CancellationToken cancellation)
    {
        while (!buffer.IsEmpty)
        {
            cancellation.ThrowIfCancellationRequested();
            int read = await stream.ReadAsync(buffer, cancellation);
            if (read == 0) throw new ProtocolException();
            buffer = buffer[read..];
        }
    }

    // Legacy JSON transport has not been adapted or reviewed. Keep its entry
    // points unconditionally closed rather than mixing two wire protocols.
    internal static Task<byte[]> ReadAsync(Stream stream, CancellationToken cancellation) =>
        Task.FromException<byte[]>(new ProtocolException());
    internal static Task WriteAsync(Stream stream, ReadOnlyMemory<byte> body, CancellationToken cancellation) =>
        Task.FromException(new ProtocolException());
    internal static ExchangeRequest ParseRequest(ReadOnlyMemory<byte> bytes) => throw new ProtocolException();
}

internal sealed record CandidateRequest(byte Operation, Guid RequestId, byte[] Payload);
internal sealed record CandidateResponse(byte Operation, Guid RequestId, byte Status, byte[] Payload);
// Retained solely to compile the disabled legacy transport.
internal sealed record ExchangeRequest(string RequestId, byte[] Body);

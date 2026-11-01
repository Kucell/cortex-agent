using System.Buffers.Binary;

namespace PermitWitness.Windows;

// Independent, internal candidate. Frames/NativeTls/Program remain v1/closed.
// This codec only frames bytes. The exchange REQUIRES an original-byte payload
// policy before releasing either direction; it has no permissive default policy.
internal static class V2Frames
{
    internal const byte Version = 2;
    internal const int MaxPayload = 1_048_576;
    internal const int RequestHeader = 18;
    internal const int ResponseHeader = 19;

    internal static byte[] Encode(V2Request request) =>
        Encode(request.Operation, request.RequestId, null, request.Payload.Span);

    internal static byte[] Encode(V2Response response) =>
        Encode(response.Operation, response.RequestId, response.Status, response.Payload.Span);

    private static byte[] Encode(byte operation, Guid id, byte? status, ReadOnlySpan<byte> payload)
    {
        if (operation is not (1 or 2) || status > 3 || payload.Length is < 1 or > MaxPayload)
            throw new ProtocolException();
        int header = status.HasValue ? ResponseHeader : RequestHeader;
        var bytes = new byte[4 + header + payload.Length];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)(header + payload.Length));
        bytes[4] = Version;
        bytes[5] = operation;
        if (!id.TryWriteBytes(bytes.AsSpan(6, 16), bigEndian: true, out int written) || written != 16)
            throw new ProtocolException();
        if (status.HasValue) bytes[22] = status.Value;
        payload.CopyTo(bytes.AsSpan(4 + header));
        return bytes;
    }

    // Called only by the connection's sole reader, once per delivered batch.
    // Read buffers are NOT limited to the remaining declared length: co-delivered
    // extra bytes must be classified before a server dispatches the first frame.
    internal sealed class Decoder(bool response)
    {
        private readonly byte[] prefix = new byte[4];
        private int prefixCount;
        private byte[]? body;
        private int bodyCount;
        internal bool Complete => body is not null && bodyCount == body.Length;
        internal bool Trailing { get; private set; }
        internal ReadOnlyMemory<byte> Payload => Complete
            ? body!.AsMemory(response ? ResponseHeader : RequestHeader) : throw new ProtocolException();
        internal byte Operation => Complete ? body![1] : throw new ProtocolException();
        internal Guid RequestId => Complete ? new(body!.AsSpan(2, 16), bigEndian: true) : throw new ProtocolException();
        internal byte Status => response && Complete ? body![18] : throw new ProtocolException();

        internal void Append(ReadOnlySpan<byte> batch)
        {
            if (Complete) { Trailing |= !batch.IsEmpty; return; }
            if (prefixCount < 4)
            {
                int count = Math.Min(4 - prefixCount, batch.Length);
                batch[..count].CopyTo(prefix.AsSpan(prefixCount));
                prefixCount += count;
                batch = batch[count..];
                if (prefixCount < 4) return;
                uint length = BinaryPrimitives.ReadUInt32BigEndian(prefix);
                int header = response ? ResponseHeader : RequestHeader;
                if (length < header + 1 || length > header + MaxPayload) throw new ProtocolException();
                body = new byte[(int)length]; // Only after role-specific unsigned range validation.
            }
            int copied = Math.Min(body!.Length - bodyCount, batch.Length);
            batch[..copied].CopyTo(body.AsSpan(bodyCount));
            bodyCount += copied;
            batch = batch[copied..];
            if (!Complete) return;
            if (body[0] != Version || body[1] is not (1 or 2) || (response && body[18] > 3))
                throw new ProtocolException();
            Trailing = !batch.IsEmpty;
        }
    }
}

internal sealed record V2Request(byte Operation, Guid RequestId, ReadOnlyMemory<byte> Payload);
internal sealed record V2Response(byte Operation, Guid RequestId, byte Status, ReadOnlyMemory<byte> Payload);

// Trusted process-local integration seam, NOT an identity assertion from JSON.
// Implementations must validate ORIGINAL bytes: fatal UTF-8, canonical format1
// JSON/limits/duplicates, exact per-action schema and result/signature binding,
// all four status/commit combinations and development-only/false. The server
// method must ALSO bind the independently authenticated peer and authorize the
// target/action. Checkpoint syntax must never become a dispatched history query.
// No production implementation or TLS bootstrap is supplied/enabled here.
internal interface IV2PayloadPolicy
{
    void ValidateRequest(V2Request request);
    void AuthorizeRequest(V2Request request);
    void ValidateResponse(V2Request request, V2Response response);
}

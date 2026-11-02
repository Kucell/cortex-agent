using System.Security.Cryptography;
using System.Text.Json.Nodes;
using PermitWitness.Windows;

// Fixture only: uses the production Frames implementation with memory streams.
// It does not construct certificates, sockets, TLS, or a witness service.
var mode = args[0];
var rows = JsonNode.Parse(File.ReadAllText(args[1]))!.AsArray();
var results = new JsonArray();
foreach (var item in rows)
{
    var row = item!;
    var name = row["name"]!.GetValue<string>();
    var direction = row["direction"]!.GetValue<string>();
    try
    {
        if (mode == "encode")
        {
            byte[] payload = File.ReadAllBytes(row["payload_path"]!.GetValue<string>());
            var id = Guid.Parse(row["request_id"]!.GetValue<string>());
            var operation = (byte)row["operation"]!.GetValue<int>();
            byte[] wire = direction == "request"
                ? Frames.EncodeRequest(operation, id, payload)
                : Frames.EncodeResponse(operation, id, (byte)row["status"]!.GetValue<int>(), payload);
            File.WriteAllBytes(row["output_path"]!.GetValue<string>(), wire);
            results.Add(new JsonObject { ["name"] = name, ["ok"] = true });
            continue;
        }

        using var stream = new ChunkStream(File.ReadAllBytes(row["wire_path"]!.GetValue<string>()),
            row["chunk"]!.GetValue<int>(), row["stall"]?.GetValue<bool>() ?? false);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(
            row["stall"]?.GetValue<bool>() == true ? 150 : 2000));
        if (direction == "request")
        {
            var frame = await Frames.ReadRequestAsync(stream, deadline.Token);
            results.Add(Result(name, frame.Operation, frame.RequestId, frame.Payload, null,
                stream.Length - stream.Position));
        }
        else
        {
            var frame = await Frames.ReadResponseAsync(stream, (byte)row["expected_operation"]!.GetValue<int>(),
                Guid.Parse(row["expected_id"]!.GetValue<string>()), new byte[] { 0x7b, 0x7d }, deadline.Token);
            results.Add(Result(name, frame.Operation, frame.RequestId, frame.Payload, frame.Status, null));
        }
    }
    catch (ProtocolException)
    {
        results.Add(new JsonObject { ["name"] = name, ["ok"] = false, ["error"] = "protocol" });
    }
    catch (OperationCanceledException)
    {
        results.Add(new JsonObject { ["name"] = name, ["ok"] = false, ["error"] = "timeout" });
    }
}
File.WriteAllText(args[2], results.ToJsonString());

static JsonObject Result(string name, byte operation, Guid id, byte[] payload, byte? status, long? remaining)
{
    var result = new JsonObject
    {
        ["name"] = name, ["ok"] = true, ["operation"] = operation, ["id"] = id.ToString(),
        ["payload_bytes"] = payload.Length, ["payload_sha256"] = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant()
    };
    if (status.HasValue) result["status"] = status.Value;
    if (remaining.HasValue) result["remaining"] = remaining.Value;
    return result;
}

sealed class ChunkStream(byte[] data, int chunk, bool stall) : MemoryStream(data)
{
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (stall && Position == Length) await Task.Delay(Timeout.Infinite, cancellationToken);
        return await base.ReadAsync(buffer[..Math.Min(chunk, buffer.Length)], cancellationToken);
    }
}

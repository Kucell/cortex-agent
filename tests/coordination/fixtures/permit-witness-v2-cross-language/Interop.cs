using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using PermitWitness.Windows;

// Real V2Frames, memory batches only. No TLS/Stream/EOF or payload policy stub.
var rows = JsonNode.Parse(File.ReadAllText(args[1]))!.AsArray();
var results = new JsonArray();
foreach (var item in rows)
{
    var row = item!;
    string name = row["name"]!.GetValue<string>();
    bool response = row["direction"]!.GetValue<string>() == "response";
    try
    {
        if (args[0] == "encode")
        {
            byte operation = (byte)row["operation"]!.GetValue<int>();
            var id = Guid.Parse(row["request_id"]!.GetValue<string>());
            byte[] payload = File.ReadAllBytes(row["payload_path"]!.GetValue<string>());
            byte[] wire = response
                ? V2Frames.Encode(new V2Response(operation, id, (byte)row["status"]!.GetValue<int>(), payload))
                : V2Frames.Encode(new V2Request(operation, id, payload));
            File.WriteAllBytes(row["output_path"]!.GetValue<string>(), wire);
            results.Add(new JsonObject { ["name"] = name, ["ok"] = true });
            continue;
        }
        byte[] bytes = File.ReadAllBytes(row["wire_path"]!.GetValue<string>());
        var decoder = new V2Frames.Decoder(response);
        JsonObject? result = null;
        int offset = 0;
        foreach (var size in row["batches"]!.AsArray())
        {
            int end = Math.Min(offset + size!.GetValue<int>(), bytes.Length);
            decoder.Append(bytes.AsSpan(offset, end - offset));
            if (decoder.Complete)
            {
                // Bool Trailing is codec-owned; exact tail length is fixture
                // accounting from the fixed prefix and the delivered batch.
                int frameBytes = checked(4 + (int)BinaryPrimitives.ReadUInt32BigEndian(bytes));
                if (decoder.Trailing != (end > frameBytes)) throw new InvalidOperationException("tail mismatch");
                result = new JsonObject { ["name"] = name, ["ok"] = true,
                    ["operation"] = decoder.Operation, ["id"] = decoder.RequestId.ToString(),
                    ["payload_bytes"] = decoder.Payload.Length,
                    ["payload_sha256"] = Convert.ToHexString(SHA256.HashData(decoder.Payload.Span)).ToLowerInvariant(),
                    ["completion_offset"] = end, ["trailing_bytes"] = end - frameBytes,
                    ["unfed_bytes"] = bytes.Length - end };
                if (response) result["status"] = decoder.Status;
                break; // Later batches belong to the exchange owner.
            }
            offset = end;
        }
        results.Add(result ?? new JsonObject { ["name"] = name, ["ok"] = false,
            ["error"] = "truncated", ["origin"] = "fixture" });
    }
    catch (ProtocolException)
    {
        // .NET has one protocol exception, not JS/Swift's separate size error.
        results.Add(new JsonObject { ["name"] = name, ["ok"] = false, ["error"] = "protocol", ["origin"] = "codec" });
    }
}
File.WriteAllText(args[2], results.ToJsonString());

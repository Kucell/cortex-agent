namespace PermitWitness.Windows;

internal static class Program
{
    public static int Main(string[] args) => Refuse(args);

    // No switches, environment, IPC claims or configuration can bypass this gate.
    // No standard stream writes: a full inherited stdout pipe must not block
    // the fail-closed path. No 1s scheduling/startup guarantee is implied.
    internal static int Refuse(string[] args) => args.Length != 0 ? 64
        : !OperatingSystem.IsWindows() ? 69 : 78;
}

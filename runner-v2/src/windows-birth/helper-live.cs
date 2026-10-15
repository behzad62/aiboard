// External qualification candidate. Build-time compilation only; no runtime compiler.
// Targets the CLR 4.0 BCL. LIVE source proposal; execution and shipping remain unqualified.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class BirthHelper
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateNamedPipeW(string name, uint access, uint mode,
        uint maximumInstances, uint outputSize, uint inputSize, uint timeout,
        ref SecurityAttributes attributes);

    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static StreamReader input;
    private static StreamWriter output;
    private static int retirementIntent;
    private static Exception peerLossDiagnosticFailure;

    private static Stream StandardStream(int kind, FileAccess access)
    {
        IntPtr handle = GetStdHandle(kind);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Standard pipe handle unavailable.");
        return new FileStream(new SafeFileHandle(handle, false), access, 4096, false);
    }
    private static bool Shape(string value, string expression)
    {
        return Regex.IsMatch(value, "\\A(?:" + expression + ")\\z", RegexOptions.CultureInvariant);
    }
    private static string Line(int maximum)
    {
        StringBuilder line = new StringBuilder();
        for (;;)
        {
            int value = input.Read();
            if (value < 0)
            {
                if (line.Length != 0) throw new InvalidDataException("Partial control EOF.");
                throw new EndOfStreamException("Control EOF.");
            }
            if (value == 10) return line.ToString();
            if ((value < 33 && value != 9) || value > 126 || line.Length >= maximum)
                throw new InvalidDataException("Invalid or overlong control ASCII.");
            line.Append((char)value);
        }
    }
    private static void Publish(string value)
    {
        output.WriteLine(value);
        output.Flush();
    }
    private static void Retire(uint code)
    {
        int selected = Interlocked.CompareExchange(ref retirementIntent, (int)code, 0);
        if (selected != 0) code = (uint)selected;
        // Native process-wide retirement is independent of a blocked query thread.
        if (!TerminateProcess(GetCurrentProcess(), code))
            Environment.FailFast("Native helper retirement failed.", new Win32Exception(Marshal.GetLastWin32Error()));
        Thread.Sleep(Timeout.Infinite);
    }
    private static Thread StartControl(string expectedClose, string ready)
    {
        Thread reader = new Thread(delegate()
        {
            try { Publish(ready); }
            catch { Retire(126); }
            try
            {
                string command = Line(256);
                Retire(String.Equals(command, expectedClose, StringComparison.Ordinal) ? 125U : 126U);
            }
            catch (EndOfStreamException) { Retire(125); }
            catch { Retire(126); }
        });
        reader.Name = "AIBoardBirthControl";
        reader.IsBackground = false;
        reader.Start();
        return reader;
    }
    private static NamedPipeServerStream LocalPipe(string name)
    {
        SecurityIdentifier sid;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) { sid = identity.User; }
        PipeSecurity security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
            PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        IntPtr pointer = Marshal.AllocHGlobal(descriptor.Length);
        IntPtr raw = IntPtr.Zero;
        try
        {
            Marshal.Copy(descriptor, 0, pointer, descriptor.Length);
            SecurityAttributes attributes = new SecurityAttributes();
            attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            attributes.Descriptor = pointer;
            attributes.Inherit = false;
            // DUPLEX | OVERLAPPED | FIRST_PIPE_INSTANCE; byte mode | REJECT_REMOTE_CLIENTS.
            raw = CreateNamedPipeW("\\\\.\\pipe\\" + name, 0x40080003, 8, 1, 4096, 4096, 0, ref attributes);
            if (raw == IntPtr.Zero || raw == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            SafePipeHandle safe = new SafePipeHandle(raw, true);
            raw = IntPtr.Zero;
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, safe); }
            catch { safe.Dispose(); throw; }
        }
        finally
        {
            if (raw != IntPtr.Zero && raw != new IntPtr(-1) && !CloseHandle(raw))
                Environment.FailFast("Unsettled native pipe creation handle.");
            Marshal.FreeHGlobal(pointer);
        }
    }
    private static byte[] Exact(Stream stream, int length)
    {
        byte[] bytes = new byte[length];
        for (int offset = 0; offset < length;)
        {
            int count = stream.Read(bytes, offset, length - offset);
            if (count <= 0) throw new EndOfStreamException("Private pipe EOF.");
            offset += count;
        }
        return bytes;
    }
    private static string Mac(byte[] key, string direction, string body)
    {
        using (HMACSHA256 mac = new HMACSHA256(key))
            return BitConverter.ToString(mac.ComputeHash(Encoding.ASCII.GetBytes(direction + '\0' + body))).Replace("-", "").ToLowerInvariant();
    }
    private static bool FixedMac(string actual, string expected)
    {
        if (!Shape(actual, "[0-9a-f]{64}") || expected.Length != 64) return false;
        int difference = 0;
        for (int index = 0; index < 64; index++) difference |= actual[index] ^ expected[index];
        return difference == 0;
    }
    private static string[] ReadFrame(Stream stream, byte[] key, string generation, string source, int sequence)
    {
        int first = stream.ReadByte();
        if (first < 0) return null; // Clean frame-boundary peer loss; only CTRL may retire the service.
        byte[] prefix = new byte[4]; prefix[0] = (byte)first;
        Buffer.BlockCopy(Exact(stream, 3), 0, prefix, 1, 3);
        uint size = BitConverter.ToUInt32(prefix, 0);
        if (size < 1 || size > 4096) throw new InvalidDataException("Private frame size.");
        byte[] bytes = Exact(stream, (int)size);
        foreach (byte value in bytes) if (value < 33 || value > 126) throw new InvalidDataException("Private frame ASCII.");
        string[] parts = Encoding.ASCII.GetString(bytes).Split('|');
        if (parts.Length != 9 || parts[0] != "v1" || parts[2] != source || parts[3] != generation ||
            !Shape(parts[5], "[0-9a-f]{32}") || parts[4] != sequence.ToString(Invariant))
            throw new InvalidDataException("Private frame binding.");
        if (sequence == 0)
        {
            if (parts[1] != "HELLO" || parts[6] != "0" || parts[7] != "-") throw new InvalidDataException("Private handshake.");
        }
        else
        {
            if (parts[1] != "QUERY" || !Shape(parts[6], "[1-9][0-9]{0,9}") ||
                Int64.Parse(parts[6], Invariant) > Int32.MaxValue || parts[7] != "-") throw new InvalidDataException("Private request.");
        }
        if (!FixedMac(parts[8], Mac(key, "c2s", String.Join("|", parts, 0, 8)))) throw new InvalidDataException("Private frame authentication.");
        return parts;
    }
    private static void WriteFrame(Stream stream, byte[] key, string[] request, string type, string payload)
    {
        string body = String.Join("|", new string[] { "v1", type, request[2], request[3], request[4], request[5], request[6], payload });
        byte[] bytes = Encoding.ASCII.GetBytes(body + "|" + Mac(key, "s2c", body));
        if (bytes.Length > 4096) throw new InvalidDataException("Private response size.");
        byte[] header = BitConverter.GetBytes((uint)bytes.Length);
        stream.Write(header, 0, 4); stream.Write(bytes, 0, bytes.Length); stream.Flush();
    }
    private static string Quote(string value)
    {
        StringBuilder json = new StringBuilder("\"");
        for (int index = 0; index < value.Length; index++)
        {
            char c = value[index];
            if (c == '"') json.Append("\\\"");
            else if (c == '\\') json.Append("\\\\");
            else if (c < 32 || Char.IsSurrogate(c)) json.Append("\\u" + ((int)c).ToString("x4", Invariant));
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }
    private static string ErrorPayload(Exception error)
    {
        Win32Exception native = error as Win32Exception;
        string code = native == null ? "NATIVE_EXCEPTION" : "WIN32_" + native.NativeErrorCode.ToString(Invariant);
        string type = error.GetType().FullName;
        if (type.Length > 80) type = type.Substring(0, 80);
        string message = error.Message;
        if (message.Length > 160) message = message.Substring(0, 160);
        for (;;)
        {
            byte[] bytes = Utf8.GetBytes("{\"code\":" + Quote(code) + ",\"class\":" + Quote(type) + ",\"message\":" + Quote(message) + "}");
            if (bytes.Length <= 360) return "UNKNOWN:" + Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            if (message.Length == 0) throw new InvalidDataException("Native error facts exceed bound.");
            message = message.Substring(0, message.Length - 1);
        }
    }
    private static void RecordPeerLoss()
    {
        // No peer-driven termination: the sole CTRL reader remains foreground and owns retirement.
        try
        {
            using (StreamWriter stderr = new StreamWriter(StandardStream(-12, FileAccess.Write), Utf8, 4096))
                stderr.WriteLine(ErrorPayload(new EndOfStreamException("Private RPC peer ended at a frame boundary.")));
        }
        catch (Exception error) { peerLossDiagnosticFailure = error; }
    }
    private static void Run(string source)
    {
        string[] boot = Line(2048).Split('\t');
        if (boot.Length != 6 || boot[0] != "BOOT1" || boot[1] != "LIVE" || !Shape(boot[2], "[0-9a-f]{64}") ||
            !Shape(boot[3], "[0-9a-f]{64}") || !Shape(boot[4], "aiboard-birth-[0-9a-f]{32}") || boot[5] != source)
            throw new InvalidDataException("Bootstrap shape/binary binding.");
        string generation = boot[2];
        byte[] key = new byte[32];
        for (int index = 0; index < 32; index++) key[index] = Convert.ToByte(boot[3].Substring(index * 2, 2), 16);
        Publish("HELPER_BOOTSTRAP|" + generation + "|" + GetCurrentProcessId().ToString(Invariant) + "|" + source);
        using (NamedPipeServerStream pipe = LocalPipe(boot[4]))
        {
            Thread control = StartControl("CLOSE1|" + generation + "|" + boot[3], "CTRL_READY|" + generation + "|" + source);
            pipe.WaitForConnection();
            string[] hello = ReadFrame(pipe, key, generation, source, 0);
            if (hello == null) { RecordPeerLoss(); return; }
            WriteFrame(pipe, key, hello, "READY", "0:0");
            int started = 0, finished = 0;
            Exception lastQueryError = null;
            for (int sequence = 1; sequence <= 999999999; sequence++)
            {
                string[] request = ReadFrame(pipe, key, generation, source, sequence);
                if (request == null) { RecordPeerLoss(); return; }
                Process process = null; Exception bodyError = null, disposeError = null; string birth = null;
                started++;
                try { process = Process.GetProcessById(Int32.Parse(request[6], Invariant)); birth = process.StartTime.ToUniversalTime().ToString("o", Invariant); }
                catch (Exception error) { bodyError = error; }
                if (process != null) try { process.Dispose(); } catch (Exception error) { disposeError = error; }
                if (bodyError != null && disposeError != null) bodyError = new AggregateException("Birth body and disposal failed.", bodyError, disposeError);
                else if (disposeError != null) bodyError = disposeError;
                finished++;
                if (bodyError != null) { lastQueryError = bodyError; WriteFrame(pipe, key, request, "RESULT", ErrorPayload(bodyError)); }
                else
                {
                    if (!Shape(birth, "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{7}Z")) throw new InvalidDataException("Native UTC7 witness unavailable.");
                    WriteFrame(pipe, key, request, "RESULT", "SAME:" + birth);
                }
            }
            GC.KeepAlive(control); GC.KeepAlive(lastQueryError); GC.KeepAlive(peerLossDiagnosticFailure);
            throw new InvalidOperationException("Finite query limit exhausted.");
        }
    }
    public static int Main(string[] args)
    {
        try
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8 || args.Length != 2 ||
                args[0] != "--binary-sha256" || !Shape(args[1], "[0-9a-f]{64}")) throw new InvalidDataException("Native helper invocation scope.");
            input = new StreamReader(StandardStream(-10, FileAccess.Read), Utf8, false, 4096);
            output = new StreamWriter(StandardStream(-11, FileAccess.Write), Utf8, 4096);
            output.NewLine = "\n";
            Run(args[1]);
            return 1;
        }
        catch (Exception error)
        {
            // Record the first terminal intent before diagnostics can block or actor EOF can race it.
            Interlocked.CompareExchange(ref retirementIntent, 1, 0);
            try
            {
                using (StreamWriter stderr = new StreamWriter(StandardStream(-12, FileAccess.Write), Utf8, 4096))
                    stderr.WriteLine(ErrorPayload(error));
            }
            catch { /* Native failure remains nonzero even when diagnostics cannot settle. */ }
            // A foreground EOF reader must not keep a failed main service alive or mask it as normal EOF.
            Retire(1);
            return 1;
        }
    }
}

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ManagedProcessJobHost
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint FILE_APPEND_DATA = 0x00000004;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_ALWAYS = 4;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        ref SECURITY_ATTRIBUTES processAttributes,
        ref SECURITY_ATTRIBUTES threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string name,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flags,
        IntPtr template);

    public static int Run(
        string command,
        string[] arguments,
        string cwd,
        IDictionary<string, string> environment,
        string stdoutPath,
        string stderrPath)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        IntPtr stdout = new IntPtr(-1);
        IntPtr stderr = new IntPtr(-1);
        IntPtr stdin = new IntPtr(-1);
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            CheckHandle(job, "CreateJobObject");
            SetKillOnClose(job);

            SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES();
            inheritable.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inheritable.bInheritHandle = true;
            stdout = CreateFile(stdoutPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            CheckHandle(stdout, "CreateFile(stdout)");
            stderr = CreateFile(stderrPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            CheckHandle(stderr, "CreateFile(stderr)");
            stdin = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            CheckHandle(stdin, "CreateFile(NUL)");

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = stdin;
            startup.hStdOutput = stdout;
            startup.hStdError = stderr;
            SECURITY_ATTRIBUTES processAttributes = inheritable;
            SECURITY_ATTRIBUTES threadAttributes = inheritable;
            environmentBlock = BuildEnvironmentBlock(environment);
            LaunchSpec launch = ResolveLaunch(command, arguments, cwd, environment);
            StringBuilder commandLine = new StringBuilder(
                BuildCommandLine(launch.Application, launch.Arguments));

            if (!CreateProcess(launch.Application, commandLine,
                ref processAttributes, ref threadAttributes,
                true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environmentBlock, cwd, ref startup, out processInfo))
                ThrowWin32("CreateProcess");
            if (!AssignProcessToJobObject(job, processInfo.hProcess))
                ThrowWin32("AssignProcessToJobObject");
            if (ResumeThread(processInfo.hThread) == 0xffffffff)
                ThrowWin32("ResumeThread");
            CloseHandle(processInfo.hThread);
            processInfo.hThread = IntPtr.Zero;
            Emit("started", processInfo.dwProcessId, null, ActiveProcesses(job), null);

            object inputLock = new object();
            string pendingCommand = null;
            bool inputCompleted = false;
            Thread inputThread = new Thread(delegate()
            {
                string line = Console.In.ReadLine();
                lock (inputLock)
                {
                    pendingCommand = line;
                    inputCompleted = true;
                }
            });
            inputThread.IsBackground = true;
            inputThread.Start();
            bool rootExited = false;
            bool rootReported = false;
            uint rootExitCode = 0;
            while (true)
            {
                bool hasInput;
                string inputLine;
                lock (inputLock)
                {
                    hasInput = inputCompleted;
                    inputLine = pendingCommand;
                }
                if (hasInput)
                {
                    if (inputLine == null)
                    {
                        TerminateAndProve(job, 5000);
                        return 0;
                    }
                    int deadline = ParseDeadline(inputLine);
                    TerminateAndProve(job, deadline);
                    Emit("stopped", processInfo.dwProcessId, null, 0, null);
                    return 0;
                }

                if (!rootExited && WaitForSingleObject(processInfo.hProcess, 50) == WAIT_OBJECT_0)
                {
                    rootExited = true;
                    if (!GetExitCodeProcess(processInfo.hProcess, out rootExitCode))
                        ThrowWin32("GetExitCodeProcess");
                }
                if (rootExited)
                {
                    uint active = ActiveProcesses(job);
                    if (active == 0)
                    {
                        Emit("natural_stopped", processInfo.dwProcessId, rootExitCode, 0, null);
                        return 0;
                    }
                    if (!rootReported)
                    {
                        rootReported = true;
                        Emit("root_exited", processInfo.dwProcessId, rootExitCode, active, null);
                    }
                }
                Thread.Sleep(25);
            }
        }
        catch (Exception error)
        {
            Emit("error", processInfo.dwProcessId, null, 0, error.Message);
            return 1;
        }
        finally
        {
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            if (stdin != new IntPtr(-1)) CloseHandle(stdin);
            if (stdout != new IntPtr(-1)) CloseHandle(stdout);
            if (stderr != new IntPtr(-1)) CloseHandle(stderr);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static void SetKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
                ThrowWin32("SetInformationJobObject");
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                pointer, (uint)size, IntPtr.Zero)) ThrowWin32("QueryInformationJobObject");
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
                (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                    pointer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return accounting.ActiveProcesses;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static void TerminateAndProve(IntPtr job, int deadlineMs)
    {
        if (!TerminateJobObject(job, 1)) ThrowWin32("TerminateJobObject");
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(250, Math.Min(30000, deadlineMs)));
        while (DateTime.UtcNow < deadline)
        {
            if (ActiveProcesses(job) == 0) return;
            Thread.Sleep(25);
        }
        throw new TimeoutException("Windows Job Object was not empty before the stop deadline.");
    }

    private static int ParseDeadline(string line)
    {
        const string marker = "\"deadlineMs\":";
        int start = line.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) return 5000;
        start += marker.Length;
        int end = start;
        while (end < line.Length && char.IsDigit(line[end])) end++;
        int value;
        return int.TryParse(line.Substring(start, end - start), out value) ? value : 5000;
    }

    private static IntPtr BuildEnvironmentBlock(IDictionary<string, string> environment)
    {
        List<string> entries = new List<string>();
        foreach (KeyValuePair<string, string> pair in environment)
            entries.Add(pair.Key + "=" + pair.Value);
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        return Marshal.StringToHGlobalUni(string.Join("\0", entries.ToArray()) + "\0\0");
    }

    private sealed class LaunchSpec
    {
        public string Application;
        public string[] Arguments;
    }

    private static LaunchSpec ResolveLaunch(
        string command,
        string[] arguments,
        string cwd,
        IDictionary<string, string> environment)
    {
        string resolved = ResolveCommand(command, cwd, environment);
        string extension = Path.GetExtension(resolved).ToLowerInvariant();
        if (extension == ".exe" || extension == ".com")
            return new LaunchSpec { Application = resolved, Arguments = arguments };
        if (extension == ".cmd" || extension == ".bat")
            return BuildBatchLaunch(resolved, arguments);
        throw new InvalidOperationException(
            "Unsupported Windows process launcher '" + extension +
            "'. process.start supports native .exe/.com programs and .cmd/.bat shims.");
    }

    private static string ResolveCommand(
        string command,
        string cwd,
        IDictionary<string, string> environment)
    {
        if (string.IsNullOrWhiteSpace(command))
            throw new ArgumentException("Process command must not be empty.");
        bool hasDirectory = command.IndexOf(Path.DirectorySeparatorChar) >= 0 ||
            command.IndexOf(Path.AltDirectorySeparatorChar) >= 0;
        List<string> bases = new List<string>();
        if (Path.IsPathRooted(command)) bases.Add(command);
        else if (hasDirectory) bases.Add(Path.GetFullPath(Path.Combine(cwd, command)));
        else
        {
            // Match ordinary process launch behavior while making the chosen binary explicit
            // before CreateProcess and before the process is resumed inside the Job Object.
            bases.Add(Path.Combine(cwd, command));
            string pathValue;
            if (environment.TryGetValue("PATH", out pathValue))
            {
                foreach (string entry in pathValue.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string directory = entry.Trim().Trim('"');
                    if (directory.Length > 0) bases.Add(Path.Combine(directory, command));
                }
            }
        }

        string[] extensions = CommandExtensions(command, environment);
        foreach (string extension in extensions)
        {
            foreach (string basePath in bases)
            {
                string candidate = basePath + extension;
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
        }
        throw new FileNotFoundException("Windows process command was not found on PATH: " + command);
    }

    private static string[] CommandExtensions(
        string command,
        IDictionary<string, string> environment)
    {
        if (Path.HasExtension(command)) return new string[] { "" };
        string pathExt;
        if (!environment.TryGetValue("PATHEXT", out pathExt) || string.IsNullOrWhiteSpace(pathExt))
            pathExt = ".COM;.EXE;.BAT;.CMD";
        return pathExt
            .Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(delegate(string value)
            {
                string trimmed = value.Trim();
                return trimmed.StartsWith(".", StringComparison.Ordinal) ? trimmed : "." + trimmed;
            })
            .ToArray();
    }

    private static LaunchSpec BuildBatchLaunch(string command, string[] arguments)
    {
        foreach (string argument in arguments)
        {
            if (argument.IndexOfAny(new char[] { '"', '%', '!', '^', '&', '|', '<', '>', '(', ')', '\r', '\n' }) >= 0)
                throw new InvalidOperationException(
                    "Unsafe .cmd/.bat argument rejected. Batch shims support ordinary argv values " +
                    "(including spaces), but not cmd.exe metacharacters. Invoke the underlying .exe " +
                    "for arbitrary argument data.");
        }
        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell))
            throw new FileNotFoundException("Windows PowerShell is required to launch .cmd/.bat shims safely.");

        string payload = "{\"command\":" + JsonQuote(command) + ",\"args\":[" +
            string.Join(",", arguments.Select(JsonQuote).ToArray()) + "]}";
        string payloadBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(payload));
        // The only interpolated value is a Base64 alphabet. Command and arguments remain JSON
        // data and are splatted as an argv array rather than concatenated into shell source.
        string script =
            "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
            payloadBase64 + "'))|ConvertFrom-Json;" +
            "$a=@($p.args|ForEach-Object{[string]$_});" +
            "& ([string]$p.command) @a;" +
            "if($null-eq$LASTEXITCODE){exit 0}else{exit $LASTEXITCODE}";
        string encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        return new LaunchSpec
        {
            Application = powershell,
            Arguments = new string[] {
                "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-EncodedCommand", encodedScript
            }
        };
    }

    private static string JsonQuote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': result.Append("\\\\"); break;
                case '"': result.Append("\\\""); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 0x20) result.Append("\\u").Append(((int)character).ToString("x4"));
                    else result.Append(character);
                    break;
            }
        }
        return result.Append('"').ToString();
    }

    private static string BuildCommandLine(string command, string[] arguments)
    {
        StringBuilder result = new StringBuilder(Quote(command));
        foreach (string argument in arguments)
            result.Append(' ').Append(Quote(argument));
        return result.ToString();
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static void Emit(string type, uint pid, uint? exitCode, uint active, string error)
    {
        string escaped = error == null ? "null" : "\"" + error.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        Console.Out.WriteLine("{\"type\":\"" + type + "\",\"pid\":" + pid +
            ",\"exitCode\":" + (exitCode.HasValue ? exitCode.Value.ToString() : "null") +
            ",\"activeProcesses\":" + active + ",\"error\":" + escaped + "}");
        Console.Out.Flush();
    }

    private static void CheckHandle(IntPtr handle, string operation)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) ThrowWin32(operation);
    }

    private static void ThrowWin32(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
}
'@

$configuration = [Console]::In.ReadLine() | ConvertFrom-Json
$environment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($property in $configuration.env.PSObject.Properties) {
    $environment[$property.Name] = [string]$property.Value
}
$exitCode = [ManagedProcessJobHost]::Run(
    [string]$configuration.command,
    [string[]]@($configuration.args),
    [string]$configuration.cwd,
    $environment,
    [string]$configuration.stdoutPath,
    [string]$configuration.stderrPath
)
exit $exitCode

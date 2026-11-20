# RUNNER_RAW_PROCESS_BOUNDARY: audited Win32 CreateProcess/Job Object host for managed and LSP workloads.
$ErrorActionPreference = "Stop"
# Load ConvertFrom-Json's module (~50 ms) before the config line arrives: a pre-started spare does it
# while it waits instead of after its claim; a fresh launch pays the same cost either way.
$null = '{}' | ConvertFrom-Json

$jobHostCsSource = @'
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
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const int PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY = 0x00020012;
    private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const uint IO_REPARSE_TAG_APPEXECLINK = 0x8000001B;
    private const uint FSCTL_GET_REPARSE_POINT = 0x000900A8;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_SHARE_DELETE_FOR_REPARSE = 0x00000004;
    // Stricter-only test fault (assign_path_exit_after_create): the launch takes the Assign path, as an app execution
    // alias does. One launch per host, so a static is enough.
    private static bool ForceAssignPath;
    private const int PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE = 0x00000002;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint FILE_APPEND_DATA = 0x00000004;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_ALWAYS = 4;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectAssociateCompletionPortInformation = 7;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint JOB_OBJECT_MSG_NEW_PROCESS = 6;
    private const int WAIT_TIMEOUT = 258;
    // An OpenProcess access right, never a Job limit (the Job's LimitFlags are only KILL_ON_JOB_CLOSE).
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int ERROR_INVALID_PARAMETER = 87;
    private const int APPMODEL_ERROR_NO_PACKAGE = 15700;
    /// <summary>Windows 10 1703: the first build that has PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY.</summary>
    private const int DESKTOP_APP_POLICY_MIN_BUILD = 15063;
    /// <summary>R4: the coded refusal when the desktop app policy cannot be set on a Windows that has it.</summary>
    public const string DesktopPolicyRefusalCode = "windows_job_desktop_policy_unavailable";
    /// <summary>R2: the coded refusal when the Job's membership messages cannot be watched.</summary>
    public const string MembershipWatchRefusalCode = "windows_job_membership_watch_unavailable";
    // Not a launch refusal: the host's error after its workload started when a member event could not be written. The
    // supervisor keeps it as member evidence, so the stop is never proven (R2).
    public const string MembershipEvidenceLostCode = "windows_job_membership_evidence_lost";

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
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
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

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OSVERSIONINFOW
    {
        public int dwOSVersionInfoSize;
        public int dwMajorVersion;
        public int dwMinorVersion;
        public int dwBuildNumber;
        public int dwPlatformId;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128)] public char[] szCSDVersion;
    }

    /// <summary>A launch refusal with a Runner code, raised before CreateProcess, so no workload process exists.</summary>
    public sealed class LaunchRefusedException : Exception
    {
        public readonly string Code;
        public LaunchRefusedException(string code, string message) : base(message) { Code = code; }
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
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
        IntPtr previousValue, IntPtr returnSize);

    // No SetLastError: it runs after a failed CreateProcess and must not replace that error.
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, ref JOBOBJECT_ASSOCIATE_COMPLETION_PORT info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateIoCompletionPort(
        IntPtr fileHandle, IntPtr existingCompletionPort, UIntPtr completionKey, uint numberOfConcurrentThreads);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetQueuedCompletionStatus(
        IntPtr completionPort, out uint numberOfBytes, out UIntPtr completionKey, out IntPtr overlapped, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PostQueuedCompletionStatus(
        IntPtr completionPort, uint numberOfBytes, UIntPtr completionKey, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFullName(IntPtr process, ref uint packageFullNameLength, StringBuilder packageFullName);

    [DllImport("ntdll.dll")]
    private static extern int RtlGetVersion(ref OSVERSIONINFOW versionInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenReparsePoint(
        string name,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flags,
        IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(IntPtr device, uint code, IntPtr inBuffer, uint inSize,
        IntPtr outBuffer, uint outSize, out uint returned, IntPtr overlapped);

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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

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
        string stderrPath,
        string injectedFault)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        IntPtr stdout = new IntPtr(-1);
        IntPtr stderr = new IntPtr(-1);
        IntPtr stdin = new IntPtr(-1);
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        MembershipWatch watch = null;
        bool desktopPolicy = false;
        bool contained = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            CheckHandle(job, "CreateJobObject");
            SetKillOnClose(job);
            watch = MembershipWatch.Start(job, EmitLine, injectedFault);

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

            // No intent event file: a root that would be created outside the Job is refused before it is created.
            if (!StartSuspended(launch, commandLine, ref processAttributes, ref threadAttributes,
                environmentBlock, cwd, startup, job, null, injectedFault, out contained, out desktopPolicy, out processInfo))
                ThrowWin32("CreateProcess");
            // The watch learns the root right after its create, before any Assign. Inside the Job (JOB_LIST) the root's
            // membership message may be handled first: the root is then identified like any member, which reports nothing
            // for an unpackaged root. Windows refuses the Job attribute for a packaged root (measured with Store pwsh, both
            // through its alias and at its target), so such a root takes the Assign path, where this runs before it joins;
            // were a packaged root ever created inside the Job, it would be reported as evidence (the stop fails closed).
            int rootPackageResult;
            watch.SetRoot(processInfo.dwProcessId, PackageFullNameOf(processInfo.hProcess, out rootPackageResult), desktopPolicy, injectedFault);
            // Only the interactive host (every production launch) takes the Assign path (StartSuspended refuses it
            // above); this stays as a second check, and the finally terminates such a root.
            if (!contained)
                throw new InvalidOperationException("The root was created outside the Job; only the interactive host assigns such a root.");
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
                        TerminateAndProve(job, DefaultStopDeadlineMs);
                        watch.Settle();
                        return 0;
                    }
                    int deadline = ParseDeadline(inputLine);
                    TerminateAndProve(job, deadline);
                    watch.Settle();
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
                        watch.Settle();
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
            LaunchRefusedException refused = error as LaunchRefusedException;
            Emit("error", processInfo.dwProcessId, null, 0, error.Message, refused == null ? null : refused.Code);
            return 1;
        }
        finally
        {
            // A root created outside the Job (only where JOB_LIST is unavailable) that never got into it: it is still
            // suspended, so it has run nothing; it is ended here rather than left behind.
            if (processInfo.hProcess != IntPtr.Zero && !contained) TerminateProcess(processInfo.hProcess, 1);
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            if (stdin != new IntPtr(-1)) CloseHandle(stdin);
            if (stdout != new IntPtr(-1)) CloseHandle(stdout);
            if (stderr != new IntPtr(-1)) CloseHandle(stderr);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (watch != null) watch.Stop();
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    // Creates the root suspended and inside the Job (PROC_THREAD_ATTRIBUTE_JOB_LIST, Windows 10+), so it is in the Job
    // from its first moment: a host killed at any point after CreateProcess leaves nothing behind (kill-on-close).
    // Where that attribute is unavailable, inJob is false and the caller assigns it before it runs, and ends it on
    // any failure first. A packaged (Microsoft Store) program, such as the
    // Store's pwsh, has its children created by default outside the desktop app environment, by a broker, so they leave
    // this Job and outlive a stop. The desktop app policy keeps the root's process tree inside: measured 2026-11-10 with
    // Store pwsh 7.6.9 starting node, node stayed in the Job and died with it. It does not reach a packaged program a
    // descendant launches (that one's children are created outside the Job either way); MembershipWatch reports such a
    // member so the stop is not claimed as proven.
    // R4: on Windows 10 1703 (build 15063) or newer, which has the attribute, a failure to build or update the attribute
    // list refuses the launch with a coded refusal before CreateProcess, so no workload process exists. Only an older
    // Windows, which has no such attribute, launches without the policy, as before.
    private static bool StartSuspended(
        LaunchSpec launch,
        StringBuilder commandLine,
        ref SECURITY_ATTRIBUTES processAttributes,
        ref SECURITY_ATTRIBUTES threadAttributes,
        IntPtr environmentBlock,
        string cwd,
        STARTUPINFO startup,
        IntPtr job,
        string intentEventPath,
        string injectedFault,
        out bool inJob,
        out bool desktopPolicy,
        out PROCESS_INFORMATION processInfo)
    {
        // An app execution alias (IO_REPARSE_TAG_APPEXECLINK, such as python3.exe or pwsh.exe under WindowsApps) names a
        // packaged program, and Windows refuses the Job attribute for it (ERROR_ACCESS_DENIED), both through the alias
        // and at the program the alias names (measured 2026-11-19 with Store pwsh 7.7.0). After that refusal the Job
        // refuses the retried root as well. So such a root takes the Assign path: created suspended, its exact identity
        // reported, then assigned. The program the alias names (the one R3 pins as the root, in a package's folder) takes
        // it too. Any other reparse point (a plain symbolic link) keeps the Job attribute.
        bool appExecLink = launch.Application != null && IsAppExecLink(launch.Application);
        bool packagedProgram = launch.Application != null && InPackageFolder(launch.Application);
        bool useJobList = !ForceAssignPath && !appExecLink && !packagedProgram;
        bool triedJobList;
        // A root created outside the Job lives there until it is assigned. Before such a create, the host's intent (its
        // own pid and creation time, and the time now) is written, so that if this host dies before it reports the
        // root's identity, its supervisor can end exactly the host's child created after that time.
        if (!useJobList) EmitAssignIntent(intentEventPath);
        if (CreateSuspended(launch, commandLine, ref processAttributes, ref threadAttributes, environmentBlock, cwd, startup,
            job, useJobList, injectedFault, out triedJobList, out inJob, out desktopPolicy, out processInfo))
            return true;
        if (!triedJobList) return false;
        // Any other refusal with the root inside the Job: created as before. If the Job then refuses the root, the
        // launch fails and the suspended root is terminated (the callers' finally), never left outside the Job.
        EmitAssignIntent(intentEventPath);
        return CreateSuspended(launch, commandLine, ref processAttributes, ref threadAttributes, environmentBlock, cwd, startup,
            job, false, injectedFault, out triedJobList, out inJob, out desktopPolicy, out processInfo);
    }

    // Whether the path is a program in a Microsoft Store package's folder, anchored to the package roots Windows uses, as
    // the Runner's PATH filter is (child-environment.ts, isWindowsAppsPathEntry): <root>\Program Files\WindowsApps\..., and
    // a package's folder on another volume's package root, <root>\WindowsApps\<Name>_..._<PublisherId>\.... A packaged
    // program anywhere else keeps the Job attribute, which Windows refuses, so its launch fails closed.
    private static bool InPackageFolder(string path)
    {
        string full;
        try { full = Path.GetFullPath(path); }
        catch (Exception) { return false; }
        if (full.StartsWith(@"\\?\", StringComparison.Ordinal)) full = full.Substring(4);
        const string root = @"^(?:[a-z]:|\\\\[^\\]+\\[^\\]+)?";
        return System.Text.RegularExpressions.Regex.IsMatch(full,
            root + @"\\program files\\windowsapps\\[^\\]+\\|" + root + @"\\windowsapps\\[^\\]+_[a-z0-9]{13}\\",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    // Whether the path is an app execution alias: its reparse tag is IO_REPARSE_TAG_APPEXECLINK. A path whose reparse
    // data cannot be read is not treated as one (its create with the Job attribute is then refused and fails closed).
    private static bool IsAppExecLink(string path)
    {
        IntPtr handle = OpenReparsePoint(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE_FOR_REPARSE,
            IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return false;
        const int size = 16 * 1024;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint returned;
            if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, IntPtr.Zero, 0, buffer, (uint)size, out returned, IntPtr.Zero) ||
                returned < 8)
                return false;
            return unchecked((uint)Marshal.ReadInt32(buffer, 0)) == IO_REPARSE_TAG_APPEXECLINK;
        }
        catch (Exception) { return false; }
        finally
        {
            Marshal.FreeHGlobal(buffer);
            CloseHandle(handle);
        }
    }

    // A created process's creation time (FILETIME ticks): with its pid, the exact identity of that process.
    private static long CreationTime(IntPtr process)
    {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) ThrowWin32("GetProcessTimes");
        return creation;
    }

    private static bool CreateSuspended(
        LaunchSpec launch,
        StringBuilder commandLine,
        ref SECURITY_ATTRIBUTES processAttributes,
        ref SECURITY_ATTRIBUTES threadAttributes,
        IntPtr environmentBlock,
        string cwd,
        STARTUPINFO startup,
        IntPtr job,
        bool useJobList,
        string injectedFault,
        out bool withJob,
        out bool inJob,
        out bool desktopPolicy,
        out PROCESS_INFORMATION processInfo)
    {
        IntPtr attributeList = IntPtr.Zero;
        IntPtr policy = IntPtr.Zero;
        IntPtr jobs = IntPtr.Zero;
        inJob = false;
        withJob = false;
        desktopPolicy = false;
        try
        {
            bool policyRequired = DesktopAppPolicyExpected();
            IntPtr size = IntPtr.Zero;
            int attributeCount = useJobList ? 2 : 1;
            InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
            int failure = Marshal.GetLastWin32Error();
            if (size != IntPtr.Zero && injectedFault != "desktop_policy_initialize")
            {
                attributeList = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributeList, attributeCount, 0, ref size))
                {
                    failure = Marshal.GetLastWin32Error();
                    Marshal.FreeHGlobal(attributeList);
                    attributeList = IntPtr.Zero;
                }
            }
            if (attributeList == IntPtr.Zero && policyRequired)
                throw new LaunchRefusedException(DesktopPolicyRefusalCode,
                    "The Windows Job host could not build the process attribute list for the desktop app policy (Win32 " +
                    failure + "), so it refused the launch: without the policy a packaged program's children would leave the Job.");
            bool withPolicy = false;
            if (attributeList != IntPtr.Zero)
            {
                policy = Marshal.AllocHGlobal(4);
                Marshal.WriteInt32(policy, PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE);
                withPolicy = injectedFault != "desktop_policy_update" &&
                    UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY),
                        policy, new IntPtr(4), IntPtr.Zero, IntPtr.Zero);
                // R4: on a Windows that has the policy, a launch without it is refused before CreateProcess, whether or
                // not the Job attribute is set (the finally frees the list).
                if (!withPolicy && policyRequired)
                {
                    failure = Marshal.GetLastWin32Error();
                    throw new LaunchRefusedException(DesktopPolicyRefusalCode,
                        "The Windows Job host could not set the desktop app policy (Win32 " + failure +
                        "), so it refused the launch: without the policy a packaged program's children would leave the Job.");
                }
                // The root is created inside the Job (Windows 10+), so no moment exists in which it lives outside it:
                // a host killed between CreateProcess and an AssignProcessToJobObject call would otherwise leave a
                // suspended root behind, outside every Job.
                if (useJobList)
                {
                    jobs = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(jobs, job);
                    withJob = UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST),
                        jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero);
                }
                if (!withPolicy && !withJob)
                {
                    // Neither attribute was set (a Windows without the policy, on the Assign path): no list.
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                    attributeList = IntPtr.Zero;
                }
            }
            desktopPolicy = withPolicy;
            STARTUPINFOEX extended = new STARTUPINFOEX();
            extended.StartupInfo = startup;
            uint creationFlags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
            if (attributeList != IntPtr.Zero)
            {
                extended.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                extended.lpAttributeList = attributeList;
                creationFlags |= EXTENDED_STARTUPINFO_PRESENT;
            }
            bool created = CreateProcess(launch.Application, commandLine,
                ref processAttributes, ref threadAttributes,
                true, creationFlags,
                environmentBlock, cwd, ref extended, out processInfo);
            inJob = created && withJob;
            return created;
        }
        finally
        {
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (policy != IntPtr.Zero) Marshal.FreeHGlobal(policy);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
        }
    }

    // True on Windows 10 1703 (build 15063) or newer, where PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY exists. RtlGetVersion
    // reports the real version whatever the host's manifest says. If it cannot answer, the policy is expected (fail closed).
    private static bool DesktopAppPolicyExpected()
    {
        OSVERSIONINFOW version = new OSVERSIONINFOW();
        version.dwOSVersionInfoSize = Marshal.SizeOf(typeof(OSVERSIONINFOW));
        if (RtlGetVersion(ref version) != 0) return true;
        return version.dwMajorVersion > 10 ||
            (version.dwMajorVersion == 10 && version.dwBuildNumber >= DESKTOP_APP_POLICY_MIN_BUILD);
    }

    // R2: the Job's own membership messages. The port is associated before the root joins, so every process that joins
    // the Job, the root and each descendant (members of nested Jobs too), posts JOB_OBJECT_MSG_NEW_PROCESS with its PID.
    // Each non-root member is opened at once and asked for its package identity. A packaged (MSIX / Microsoft Store)
    // member is evidence that the stop cannot be proven: Windows creates a packaged program's children outside this Job
    // unless the program is the Job's root (PR #167), so they can outlive the Job. A member that cannot be identified (it
    // was gone before it could be opened, or its PID no longer names a member), a Job whose process count is ahead of
    // the messages received (Windows does not guarantee their delivery), or a watch that fails is the same evidence: the
    // stop fails closed. The evidence goes out as a "member" event at once, and the supervisor keeps it in its durable
    // status. This is the Job's own evidence, never a host census: a packaged program created outside the Job, by
    // anything, is not seen here.
    private sealed class MembershipWatch
    {
        private static readonly UIntPtr SettleKey = new UIntPtr(2);
        private const int MaxReports = 16;
        // The settle wait returns the moment the watch has handled its queue (an event, never a sleep); this is only its
        // ceiling. Measured 2026-11-18 (16 cores; single process, 40 sequential and 40 detached children, a Store pwsh
        // root starting node; idle and under 4 and 6 busy cores): 120 of 120 settles took under 1 ms (watch_settled).
        // A settle past the ceiling is evidence (fail closed), so it sits thousands of times above the measured worst.
        private const int SettleWaitMs = 5000;
        private readonly IntPtr job;
        private readonly IntPtr port;
        private readonly Action<string> emit;
        private readonly object gate = new object();
        private uint rootPid;
        private string rootPackage;
        private bool rootPolicy;
        private long seen;
        private long explained;
        private int quietMismatches;
        private int reports;
        private readonly List<string> pending = new List<string>();
        private string failEmits;
        // Set once the watch is settled or stopped: from then on it never touches the Job (whose handle the host closes
        // next, so a later query would fail and read as false evidence). Read and written only under gate.
        private bool finished;
        private ManualResetEvent settled;

        private MembershipWatch(IntPtr job, IntPtr port, Action<string> emit)
        {
            this.job = job;
            this.port = port;
            this.emit = emit;
        }

        public static MembershipWatch Start(IntPtr job, Action<string> emit, string injectedFault)
        {
            IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            if (port == IntPtr.Zero)
                throw new LaunchRefusedException(MembershipWatchRefusalCode,
                    "The Windows Job host could not create a completion port for the Job's membership messages (Win32 " +
                    Marshal.GetLastWin32Error() + "), so it refused the launch.");
            JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
            association.CompletionKey = new IntPtr(1);
            association.CompletionPort = port;
            bool associated = injectedFault != "membership_watch" && SetInformationJobObject(job,
                JobObjectAssociateCompletionPortInformation, ref association,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT)));
            if (!associated)
            {
                int failure = Marshal.GetLastWin32Error();
                CloseHandle(port);
                throw new LaunchRefusedException(MembershipWatchRefusalCode,
                    "The Windows Job host could not watch the Job's membership messages (Win32 " + failure +
                    "), so it refused the launch: a packaged descendant could not be detected.");
            }
            MembershipWatch watch = new MembershipWatch(job, port, emit);
            Thread thread = new Thread(watch.Loop);
            thread.IsBackground = true;
            // Opens each member as soon as its message arrives, ahead of the workload's own threads.
            thread.Priority = ThreadPriority.Highest;
            thread.Start();
            return watch;
        }

        /// <summary>
        /// Called after CreateProcess and before AssignProcessToJobObject, so the root's message is known. A packaged root
        /// started with the desktop app policy passes its identity to its descendants (measured 2026-11-18, Store pwsh
        /// 7.7: node, conhost and a second pwsh it started all carried it), and those stay in the Job and die with it, so a
        /// member with exactly the root's package under the policy is not evidence. Any other packaged member is.
        /// </summary>
        public void SetRoot(uint pid, string package, bool desktopPolicy, string injectedFault)
        {
            lock (gate)
            {
                rootPid = pid;
                // Test faults, stricter only: each treats the root as unpackaged, so its members are reported; the
                // member_emit_* ones also fail member writes (see Flush).
                bool emitFault = injectedFault == "member_emit_retry" || injectedFault == "member_emit_lost" ||
                    injectedFault == "member_emit_unwritable";
                rootPackage = injectedFault == "membership_ignore_root_package" || emitFault ? null : package;
                failEmits = emitFault ? injectedFault : null;
                rootPolicy = desktopPolicy;
            }
        }

        /// <summary>
        /// Before a terminal event: every message queued so far is handled (the port is first in, first out, so the
        /// settle packet comes after them), then the Job's own process count is compared with the messages received.
        /// </summary>
        public void Settle()
        {
            ManualResetEvent done = new ManualResetEvent(false);
            System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
            lock (gate)
            {
                if (finished) throw new InvalidOperationException("The Job's membership watch was already settled or stopped.");
                settled = done;
            }
            if (!PostQueuedCompletionStatus(port, 0, SettleKey, IntPtr.Zero))
                lock (gate) Report(0, "unidentified", null, "The Job's membership messages could not be settled (Win32 " +
                    Marshal.GetLastWin32Error() + ").");
            else if (!done.WaitOne(SettleWaitMs))
                lock (gate) Report(0, "unidentified", null, "The Job's membership messages did not settle within " +
                    SettleWaitMs + " ms.");
            lock (gate)
            {
                finished = true;
                // Evidence only, never a lifecycle fact: how long the settle took, the measure SettleWaitMs is set from.
                try { emit("{\"type\":\"watch_settled\",\"ms\":" + clock.ElapsedMilliseconds + ",\"members\":" + seen + "}"); }
                catch (Exception) { }
                Flush(false);
                // A member event that could not be written must not end as a clean stop: the host reports an error.
                if (pending.Count > 0) throw new LaunchRefusedException(MembershipEvidenceLostCode,
                    "The Windows Job host could not record its membership evidence, so the stop is not proven.");
            }
        }

        /// <summary>
        /// Before the host closes the Job handle, on every path: the watch stops touching the Job. Every handling step runs
        /// under gate, so once this returns no step that could still query the Job is running or will run.
        /// </summary>
        public void Stop()
        {
            lock (gate) finished = true;
            PostQueuedCompletionStatus(port, 0, SettleKey, IntPtr.Zero);
        }

        private void Loop()
        {
            while (true)
            {
                try
                {
                    uint message;
                    UIntPtr key;
                    IntPtr overlapped;
                    if (!GetQueuedCompletionStatus(port, out message, out key, out overlapped, 100))
                    {
                        int failure = Marshal.GetLastWin32Error();
                        lock (gate)
                        {
                            if (finished) return;
                            Flush(false);
                            if (failure == WAIT_TIMEOUT) { CheckAccounting(false); continue; }
                            Report(0, "unidentified", null, "The Job's membership messages stopped (Win32 " + failure + ").");
                        }
                        return;
                    }
                    lock (gate)
                    {
                        if (finished) return;
                        Flush(false);
                        if (key == SettleKey)
                        {
                            CheckAccounting(true);
                            // Settled: the host emits its terminal event and closes the Job next, so the watch ends here.
                            finished = true;
                            if (settled != null) settled.Set();
                            return;
                        }
                        if (message != JOB_OBJECT_MSG_NEW_PROCESS) continue;
                        seen++;
                        uint pid = unchecked((uint)overlapped.ToInt64());
                        if (pid != rootPid) Identify(pid);
                    }
                }
                catch (Exception error)
                {
                    lock (gate)
                    {
                        if (finished) return;
                        Report(0, "unidentified", null, "The Job's membership watch failed: " + error.Message);
                    }
                }
            }
        }

        // The members the Job counted that no message named: past one quiet interval (a message can be in flight), or at
        // once when settling, they are unidentified members.
        private void CheckAccounting(bool final)
        {
            long missing = (long)TotalProcesses(job) - seen - explained;
            if (missing <= 0) { quietMismatches = 0; return; }
            if (!final && ++quietMismatches < 2) return;
            quietMismatches = 0;
            explained += missing;
            Report(0, "unidentified", null, missing + " process(es) joined the Job without a membership message.");
        }

        private void Identify(uint pid)
        {
            // A member that already exited is not evidence: OpenProcess fails with ERROR_INVALID_PARAMETER, or its PID
            // now names another process, outside this Job (a process never leaves its Job). Short-lived members whose
            // parent drops its handle at once (cmd's `start /b`, a sequential `cmd /c`) do this routinely under load, and
            // in every measured shape Windows created a packaged program outside the Job rather than as a member
            // (docs/runner-v2/codex-windows-job-escape-2026-11-18.md §6). Any other failure stays unidentified.
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero)
            {
                int failure = Marshal.GetLastWin32Error();
                if (failure == ERROR_INVALID_PARAMETER) return;
                Report(pid, "unidentified", null, "The member could not be opened to read its package identity (Win32 " +
                    failure + ").");
                return;
            }
            try
            {
                bool inJob;
                if (!IsProcessInJob(process, job, out inJob))
                {
                    Report(pid, "unidentified", null, "Its membership of this Job could not be read (Win32 " +
                        Marshal.GetLastWin32Error() + ").");
                    return;
                }
                if (!inJob) return;
                int result;
                string package = PackageFullNameOf(process, out result);
                if (result == APPMODEL_ERROR_NO_PACKAGE) return;
                if (package == null)
                {
                    Report(pid, "unidentified", null, "Its package identity could not be read (error " + result + ").");
                    return;
                }
                if (rootPolicy && rootPackage != null && String.Equals(package, rootPackage, StringComparison.Ordinal)) return;
                Report(pid, "packaged", package,
                    "A packaged (MSIX or Microsoft Store) program ran in the Job as a descendant; Windows creates its children outside the Job.");
            }
            finally { CloseHandle(process); }
        }

        private void Report(uint pid, string evidence, string package, string detail)
        {
            if (reports >= MaxReports) return;
            reports++;
            string line = "{\"type\":\"member\",\"pid\":" + pid + ",\"evidence\":\"" + evidence + "\",\"package\":" +
                (package == null ? "null" : JsonQuote(package)) + ",\"detail\":" + JsonQuote(detail) + "}";
            pending.Add(line);
            Flush(failEmits != null);
        }

        // Writes the pending member lines in order. Never throws: an exception would end the host on a background thread,
        // losing the evidence while the host's exit still read as the Job's empty proof. A line that cannot be written
        // stays pending and is retried at the watch's next wake (at most 100 ms later); one still pending when the watch
        // settles fails the stop (MembershipEvidenceLostCode). injectFailure fails this attempt (stricter-only test
        // faults: member_emit_retry fails each line's first attempt; member_emit_lost and member_emit_unwritable every
        // attempt, and member_emit_unwritable also the host's coded error line).
        private void Flush(bool injectFailure)
        {
            while (pending.Count > 0)
            {
                try
                {
                    if (injectFailure || (failEmits != null && failEmits != "member_emit_retry"))
                        throw new IOException("injected " + failEmits);
                    emit(pending[0]);
                    pending.RemoveAt(0);
                }
                catch (Exception) { return; }
            }
        }
    }

    // A process's package full name, or null: result is APPMODEL_ERROR_NO_PACKAGE for an unpackaged process, 0 for a
    // packaged one, and any other value when the identity could not be read. Before Windows 8 there is no
    // GetPackageFullName and no packaged programs, so that reads as unpackaged.
    private static string PackageFullNameOf(IntPtr process, out int result)
    {
        try
        {
            uint length = 0;
            result = GetPackageFullName(process, ref length, null);
            if (result != ERROR_INSUFFICIENT_BUFFER) return null;
            StringBuilder name = new StringBuilder((int)length);
            result = GetPackageFullName(process, ref length, name);
            return result == 0 ? name.ToString() : null;
        }
        catch (EntryPointNotFoundException)
        {
            result = APPMODEL_ERROR_NO_PACKAGE;
            return null;
        }
    }

    private static uint TotalProcesses(IntPtr job)
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
            return accounting.TotalProcesses;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    // The LSP mode keeps its standard streams transparent: the PowerShell host
    // reads one bootstrap line, then the launched server exclusively owns the
    // inherited stdin/stdout/stderr handles. The Job Object remains open until
    // the root and every descendant are gone, and closing this host kills all of
    // them through JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    public static int RunInteractive(
        string command,
        string[] arguments,
        string cwd,
        IDictionary<string, string> environment,
        string eventPath,
        string injectedFault)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        MembershipWatch watch = null;
        bool desktopPolicy = false;
        bool contained = false;
        try
        {
            // Stricter-only test fault: a host that takes longer to start than its launcher waits (a loaded host).
            if (injectedFault == "slow_start_late_close") Thread.Sleep(30000);
            ForceAssignPath = injectedFault == "assign_path_exit_after_create" || injectedFault == "assign_path_exit_before_assign";
            job = CreateJobObject(IntPtr.Zero, null);
            CheckHandle(job, "CreateJobObject");
            SetKillOnClose(job);
            watch = MembershipWatch.Start(job, delegate(string line) { EmitLspLine(eventPath, line); }, injectedFault);

            IntPtr stdin = GetStdHandle(STD_INPUT_HANDLE);
            IntPtr stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            IntPtr stderr = GetStdHandle(STD_ERROR_HANDLE);
            CheckHandle(stdin, "GetStdHandle(stdin)");
            CheckHandle(stdout, "GetStdHandle(stdout)");
            CheckHandle(stderr, "GetStdHandle(stderr)");
            MakeInheritable(stdin, "SetHandleInformation(stdin)");
            MakeInheritable(stdout, "SetHandleInformation(stdout)");
            MakeInheritable(stderr, "SetHandleInformation(stderr)");

            SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES();
            inheritable.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inheritable.bInheritHandle = true;
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

            // Stricter-only test fault (assign_path_exit_after_create): another child of this host, created before the
            // intent, outside the Job, that stays alive 60 s; the supervisor must leave it alone. It is started through
            // the shell, so it inherits none of this host's handles (its pipes stay the host's own).
            if (injectedFault == "assign_path_exit_after_create")
            {
                System.Diagnostics.ProcessStartInfo sentinelStart = new System.Diagnostics.ProcessStartInfo(
                    Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
                    "-NoLogo -NoProfile -NonInteractive -Command Start-Sleep 60");
                sentinelStart.UseShellExecute = true;
                sentinelStart.WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden;
                System.Diagnostics.Process sentinel = System.Diagnostics.Process.Start(sentinelStart);
                EmitLsp(eventPath, "fault_sentinel", (uint)sentinel.Id, null, 0, null);
            }
            if (!StartSuspended(launch, commandLine, ref processAttributes, ref threadAttributes,
                environmentBlock, cwd, startup, job, eventPath, injectedFault, out contained, out desktopPolicy, out processInfo))
                ThrowWin32("CreateProcess");
            // Stricter-only test faults: the host dies right after CreateProcess, before resume, as a kill of the host
            // would. Inside the Job (JOB_LIST) the Job's kill-on-close ends the root; on the Assign path the supervisor
            // ends the host's child created after the written intent.
            if (injectedFault == "host_exit_after_create" || (injectedFault == "assign_path_exit_after_create" && !contained))
            {
                EmitLsp(eventPath, "fault_created", processInfo.dwProcessId, null, 0, null);
                System.Diagnostics.Process.GetCurrentProcess().Kill();
            }
            // The watch learns the root right after its create, before any Assign. Inside the Job (JOB_LIST) the root's
            // membership message may be handled first: the root is then identified like any member, which reports nothing
            // for an unpackaged root. Windows refuses the Job attribute for a packaged root (measured with Store pwsh, both
            // through its alias and at its target), so such a root takes the Assign path, where this runs before it joins;
            // were a packaged root ever created inside the Job, it would be reported as evidence (the stop fails closed).
            int rootPackageResult;
            watch.SetRoot(processInfo.dwProcessId, PackageFullNameOf(processInfo.hProcess, out rootPackageResult), desktopPolicy, injectedFault);
            if (!contained)
            {
                // The Assign path: the suspended root lives outside the Job until it is assigned. Its exact identity
                // (pid and creation time) is written first, so the supervisor can end exactly that process if this
                // host dies before the Assign (a write that fails throws, and the finally terminates the root).
                EmitAssignPending(eventPath, processInfo.dwProcessId, CreationTime(processInfo.hProcess));
                // Stricter-only test fault: the host dies after it reported the root's identity, before the Assign.
                if (injectedFault == "assign_path_exit_before_assign")
                {
                    EmitLsp(eventPath, "fault_created", processInfo.dwProcessId, null, 0, null);
                    System.Diagnostics.Process.GetCurrentProcess().Kill();
                }
                if (!AssignProcessToJobObject(job, processInfo.hProcess))
                    ThrowWin32("AssignProcessToJobObject");
                contained = true;
            }
            if (ResumeThread(processInfo.hThread) == 0xffffffff)
                ThrowWin32("ResumeThread");
            CloseHandle(processInfo.hThread);
            processInfo.hThread = IntPtr.Zero;
            // Stricter-only test fault: the workload runs (and may write output) while its started line is late, as on a
            // loaded host; a launcher that gives up meanwhile aborts a start whose workload already ran.
            if (injectedFault == "late_started_line") Thread.Sleep(30000);
            // Stricter-only test fault: the started line cannot be written. The workload runs for the write's retry
            // window (about a second, EmitLspLine) before the failure is thrown, and no later line is written either.
            if (injectedFault == "started_emit_unwritable")
            {
                Thread.Sleep(1000);
                throw new IOException("injected started_emit_unwritable");
            }
            EmitLsp(eventPath, "started", processInfo.dwProcessId, null, ActiveProcesses(job), null);

            bool rootExited = false;
            bool rootReported = false;
            uint rootExitCode = 0;
            // T1 CPU evidence (managed sessions only, never on the LSP stderr channel):
            // whole-Job user+kernel time, at most every 500 ms when it changed, plus a
            // 5 s heartbeat while unchanged. Evidence only, never a lifecycle fact.
            bool accounting = !String.IsNullOrWhiteSpace(eventPath);
            System.Diagnostics.Stopwatch accountingClock = System.Diagnostics.Stopwatch.StartNew();
            long lastAccountingMs = -1000000;
            long lastAccountingEmitMs = -1000000;
            long lastCpu = -1;
            long accountingBytes = 0;
            while (true)
            {
                if (!rootExited && WaitForSingleObject(processInfo.hProcess, 50) == WAIT_OBJECT_0)
                {
                    rootExited = true;
                    if (!GetExitCodeProcess(processInfo.hProcess, out rootExitCode))
                        ThrowWin32("GetExitCodeProcess");
                }
                if (accounting)
                {
                    // Evidence must never become a lifecycle fact: any accounting failure (a
                    // transiently locked or full event file, a failed query) or reaching the
                    // byte budget only turns accounting off; callers then lose CPU evidence.
                    try
                    {
                        long elapsed = accountingClock.ElapsedMilliseconds;
                        if (elapsed - lastAccountingMs >= 500)
                        {
                            lastAccountingMs = elapsed;
                            long cpu = TotalCpu100ns(job);
                            if (cpu != lastCpu || elapsed - lastAccountingEmitMs >= 5000)
                            {
                                lastCpu = cpu;
                                lastAccountingEmitMs = elapsed;
                                accountingBytes += EmitAccounting(eventPath, processInfo.dwProcessId, cpu);
                                if (accountingBytes >= AccountingByteBudget) accounting = false;
                            }
                        }
                    }
                    catch (Exception) { accounting = false; }
                }
                if (rootExited)
                {
                    uint active = ActiveProcesses(job);
                    if (active == 0)
                    {
                        watch.Settle();
                        EmitLsp(eventPath, "natural_stopped", processInfo.dwProcessId, rootExitCode, 0, null);
                        return unchecked((int)rootExitCode);
                    }
                    if (!rootReported)
                    {
                        rootReported = true;
                        EmitLsp(eventPath, "root_exited", processInfo.dwProcessId, rootExitCode, active, null);
                    }
                }
                Thread.Sleep(25);
            }
        }
        catch (Exception error)
        {
            Win32Exception native = error as Win32Exception;
            LaunchRefusedException refused = error as LaunchRefusedException;
            string detail = native == null
                ? error.Message
                : error.Message + " (Win32 " + native.NativeErrorCode + ")";
            // Stricter-only test fault: the event file stays unwritable for the coded line too. The supervisor then sees
            // a host that ended after its workload started with no natural stop and no stop request (R2 evidence).
            if (refused != null && refused.Code == MembershipEvidenceLostCode && injectedFault == "member_emit_unwritable")
                throw new IOException("injected member_emit_unwritable");
            if (injectedFault == "started_emit_unwritable")
                throw new IOException("injected started_emit_unwritable");
            // R2: "launched": false only when no process was ever created (a coded refusal or a CreateProcess failure).
            // Any other failure before the started line leaves the Job's membership unsettled, and the supervisor keeps
            // that as evidence.
            string line = EventLine("error", processInfo.dwProcessId, null, 0, detail, refused == null ? null : refused.Code);
            if (processInfo.hProcess == IntPtr.Zero) line = line.Substring(0, line.Length - 1) + ",\"launched\":false}";
            EmitLspLine(eventPath, line);
            return 1;
        }
        finally
        {
            // A root created outside the Job (only where JOB_LIST is unavailable) that never got into it: it is still
            // suspended, so it has run nothing; it is ended here rather than left behind.
            if (processInfo.hProcess != IntPtr.Zero && !contained) TerminateProcess(processInfo.hProcess, 1);
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (watch != null) watch.Stop();
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

    private static void MakeInheritable(IntPtr handle, string operation)
    {
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
            ThrowWin32(operation);
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

    private static long TotalCpu100ns(IntPtr job)
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
            return accounting.TotalUserTime + accounting.TotalKernelTime;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    /// <summary>T1: accounting events stop after this many bytes so a long busy session cannot grow the event file without bound.</summary>
    private const long AccountingByteBudget = 16L * 1024 * 1024;

    private static int EmitAccounting(string eventPath, uint pid, long cpu100ns)
    {
        string line = "{\"type\":\"accounting\",\"pid\":" + pid +
            ",\"exitCode\":null,\"activeProcesses\":0,\"error\":null,\"cpu100ns\":" + cpu100ns + "}" +
            Environment.NewLine;
        lock (EventLock) File.AppendAllText(eventPath, line, new UTF8Encoding(false));
        return line.Length;
    }

    private const int DefaultStopDeadlineMs = 60000;

    private static void TerminateAndProve(IntPtr job, int deadlineMs)
    {
        if (!TerminateJobObject(job, 1)) ThrowWin32("TerminateJobObject");
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(250, Math.Min(DefaultStopDeadlineMs, deadlineMs)));
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
        if (start < 0) return DefaultStopDeadlineMs;
        start += marker.Length;
        int end = start;
        while (end < line.Length && char.IsDigit(line[end])) end++;
        int value;
        return int.TryParse(line.Substring(start, end - start), out value) ? value : DefaultStopDeadlineMs;
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
        // cmd.exe reads no \" escapes: with /s /c it runs everything between the first and the last quote as typed,
        // so a script keeps its own quotes (git commit -m "fix: tests") only when it is passed that way.
        string name = Path.GetFileName(command);
        if (arguments.Length == 4 && arguments[0] == "/d" && arguments[1] == "/s" && arguments[2] == "/c" &&
            (String.Equals(name, "cmd.exe", StringComparison.OrdinalIgnoreCase) || String.Equals(name, "cmd", StringComparison.OrdinalIgnoreCase)))
            return Quote(command) + " /d /s /c \"" + arguments[3] + "\"";
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

    // One writer at a time: the membership watch writes events from its own thread.
    private static readonly object EventLock = new object();

    private static string EventLine(string type, uint pid, uint? exitCode, uint active, string error, string code)
    {
        string escaped = error == null ? "null" : "\"" + error.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        return "{\"type\":\"" + type + "\",\"pid\":" + pid +
            ",\"exitCode\":" + (exitCode.HasValue ? exitCode.Value.ToString() : "null") +
            ",\"activeProcesses\":" + active + ",\"error\":" + escaped +
            (code == null ? "" : ",\"code\":\"" + code + "\"") + "}";
    }

    private static void Emit(string type, uint pid, uint? exitCode, uint active, string error)
    {
        Emit(type, pid, exitCode, active, error, null);
    }

    private static void Emit(string type, uint pid, uint? exitCode, uint active, string error, string code)
    {
        EmitLine(EventLine(type, pid, exitCode, active, error, code));
    }

    private static void EmitLine(string line)
    {
        lock (EventLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    // The Assign path's intent, written before the root is created outside the Job: this host's pid and creation time,
    // and the time now (FILETIME ticks, as strings: they exceed the integers a JSON reader keeps exactly). Without an
    // event file (the non-interactive host) a root outside the Job is refused before it is created.
    private static void EmitAssignIntent(string eventPath)
    {
        if (String.IsNullOrWhiteSpace(eventPath))
            throw new InvalidOperationException("The root would be created outside the Job; only the interactive host assigns such a root.");
        long hostCreation = CreationTime(GetCurrentProcess());
        long now = DateTime.UtcNow.ToFileTimeUtc();
        File.AppendAllText(eventPath, "{\"type\":\"assign_intent\",\"hostPid\":" + System.Diagnostics.Process.GetCurrentProcess().Id +
            ",\"hostCreationTime\":\"" + hostCreation + "\",\"at\":\"" + now + "\"}" + Environment.NewLine, new UTF8Encoding(false));
    }

    // The Assign path's exact identity of the suspended root. The creation time is a string: FILETIME ticks exceed the
    // integers a JSON reader keeps exactly.
    private static void EmitAssignPending(string eventPath, uint pid, long creationTime)
    {
        if (String.IsNullOrWhiteSpace(eventPath)) throw new InvalidOperationException("The Assign path needs an event file.");
        File.AppendAllText(eventPath, "{\"type\":\"assign_pending\",\"pid\":" + pid + ",\"creationTime\":\"" + creationTime + "\"}" +
            Environment.NewLine, new UTF8Encoding(false));
    }

    private static void EmitLsp(string eventPath, string type, uint pid, uint? exitCode, uint active, string error)
    {
        EmitLsp(eventPath, type, pid, exitCode, active, error, null);
    }

    private static void EmitLsp(string eventPath, string type, uint pid, uint? exitCode, uint active, string error, string code)
    {
        EmitLspLine(eventPath, EventLine(type, pid, exitCode, active, error, code));
    }

    // A lifecycle or evidence event: a write that fails (the file briefly held by another reader) is retried for about
    // a second before the failure is thrown.
    private static void EmitLspLine(string eventPath, string line)
    {
        lock (EventLock)
        {
            if (String.IsNullOrWhiteSpace(eventPath))
            {
                Console.Error.WriteLine("@aiboard-lsp-job-host:" + line);
                Console.Error.Flush();
                return;
            }
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    File.AppendAllText(eventPath, line + Environment.NewLine, new UTF8Encoding(false));
                    return;
                }
                catch (IOException)
                {
                    if (attempt >= 40) throw;
                    Thread.Sleep(25);
                }
            }
        }
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

// The stop-time escape sweep (Start-Process gap, docs/runner-v2/codex-windows-job-escape-2026-11-18.md §7). A packaged
// (Store) program that a process in the Job starts is created outside the Job, so the Job's stop never sees it. The
// Runner gives every process it starts for one owner a random environment mark, and after that owner's stop this
// takes one snapshot of the host's processes and ends those that carry the mark. Each fact is read through the one
// handle that would end the process: its creation time (no later than the mark's issue means it is never ended), its
// user and session, and the mark in its environment. A process is ended only when the mark is read through that
// handle; nothing else (a parent PID, a name) ever authorizes it. A process whose facts cannot be read is reported as
// unreadable and never ended. A marked process that cannot be ended, whose exit is not seen, or that sits in a job
// without being packaged (a Runner Job member, or a job the Runner cannot attribute) leaves the sweep unproven.
public static class ManagedProcessEscapeSweep
{
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const int TokenUser = 1;
    private const int ProcessBasicInformation = 0;
    private const uint WAIT_OBJECT_0 = 0;
    private const int APPMODEL_ERROR_NO_PACKAGE = 15700;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    // x64 offsets: PEB.ProcessParameters, RTL_USER_PROCESS_PARAMETERS.Environment and .EnvironmentSize (Vista and later).
    private const int PebProcessParametersOffset = 0x20;
    private const int ParametersEnvironmentOffset = 0x80;
    private const int ParametersEnvironmentSizeOffset = 0x3F0;
    private const long MaxEnvironmentBytes = 4L * 1024 * 1024;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);

    private sealed class Entry
    {
        public uint Pid;
        public long Created;
        public string Image = "";
        public string Reason;
        public bool Packaged;
        public bool InJob;
    }

    /// <summary>
    /// Ends every process of this user and session, created after <paramref name="sinceFileTime"/>, whose environment
    /// holds exactly <paramref name="markName"/>=<paramref name="markValue"/>. Repeats the snapshot until one round
    /// finds no marked process left, at most <paramref name="maxRounds"/> rounds. Returns the report as one JSON line.
    /// </summary>
    public static string Sweep(string markName, string markValue, long sinceFileTime, int exitWaitMs, int maxRounds, string fault)
    {
        if (IntPtr.Size != 8) throw new InvalidOperationException("The escape sweep reads 64-bit process parameters only.");
        if (string.IsNullOrEmpty(markName) || string.IsNullOrEmpty(markValue) || sinceFileTime <= 0 || exitWaitMs < 1 || maxRounds < 1)
            throw new ArgumentException("The escape sweep request is invalid.");
        if (fault == "query_fails") throw new InvalidOperationException("injected escape sweep query failure");
        uint self = GetCurrentProcessId();
        uint mySession;
        if (!ProcessIdToSessionId(self, out mySession)) throw new Win32Exception(Marshal.GetLastWin32Error(), "ProcessIdToSessionId");
        string mySid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        var ended = new List<Entry>();
        var unended = new List<Entry>();
        var unreadable = new Dictionary<string, Entry>();
        int unqueried = 0;
        bool settled = false;
        int rounds = 0;
        while (rounds < maxRounds)
        {
            rounds++;
            int marked = 0;
            unqueried = 0;
            foreach (uint pid in SnapshotProcessIds())
            {
                if (pid == 0 || pid == 4 || pid == self) continue;
                uint session;
                if (!ProcessIdToSessionId(pid, out session)) { unqueried++; continue; }
                if (session != mySession) continue;
                Entry entry;
                IntPtr handle = Inspect(pid, sinceFileTime, mySid, markName, markValue, out entry, ref unqueried);
                if (entry == null) continue;
                if (handle == IntPtr.Zero)
                {
                    unreadable[pid + ":" + entry.Created] = entry;
                    continue;
                }
                try
                {
                    marked++;
                    if (entry.Reason != null)
                    {
                        unended.Add(entry);
                        continue;
                    }
                    if (entry.InJob && !entry.Packaged)
                    {
                        entry.Reason = "in_job_not_packaged";
                        unended.Add(entry);
                        continue;
                    }
                    if (fault == "terminate_fails")
                    {
                        entry.Reason = "injected_terminate_failure";
                        unended.Add(entry);
                        continue;
                    }
                    bool terminated = TerminateProcess(handle, 1);
                    int terminateError = terminated ? 0 : Marshal.GetLastWin32Error();
                    if (WaitForSingleObject(handle, (uint)exitWaitMs) == WAIT_OBJECT_0) ended.Add(entry);
                    else
                    {
                        entry.Reason = terminated ? "exit_not_seen" : "terminate_failed_" + terminateError;
                        unended.Add(entry);
                    }
                }
                finally { CloseHandle(handle); }
            }
            if (unended.Count > 0) break;
            if (marked == 0) { settled = true; break; }
        }
        var json = new StringBuilder();
        json.Append("{\"settled\":").Append(settled && unended.Count == 0 ? "true" : "false");
        json.Append(",\"rounds\":").Append(rounds);
        json.Append(",\"ended\":"); AppendEntries(json, ended);
        json.Append(",\"unended\":"); AppendEntries(json, unended);
        json.Append(",\"unreadable\":"); AppendEntries(json, unreadable.Values);
        json.Append(",\"unqueried\":").Append(unqueried).Append("}");
        return json.ToString();
    }

    // Opens the process once and reads every fact through that handle. Returns the handle (the caller ends and closes
    // it) for a marked process; IntPtr.Zero with an entry for an unreadable one; IntPtr.Zero and no entry otherwise.
    private static IntPtr Inspect(uint pid, long since, string mySid, string markName, string markValue, out Entry entry, ref int unqueried)
    {
        entry = null;
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE | SYNCHRONIZE, false, pid);
        if (handle == IntPtr.Zero)
        {
            // Not openable for reading and ending (an elevated or protected process, or one that just exited). Its
            // creation time decides whether it is reported: one older than the mark is never this owner's.
            IntPtr limited = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (limited == IntPtr.Zero) { unqueried++; return IntPtr.Zero; }
            try
            {
                long created = CreationTime(limited);
                if (created == 0) { unqueried++; return IntPtr.Zero; }
                if (created <= since) return IntPtr.Zero;
                entry = new Entry { Pid = pid, Created = created, Image = ImagePath(limited), Reason = "open_denied" };
                return IntPtr.Zero;
            }
            finally { CloseHandle(limited); }
        }
        bool keep = false;
        try
        {
            long created = CreationTime(handle);
            if (created == 0) { unqueried++; return IntPtr.Zero; }
            if (created <= since) return IntPtr.Zero;
            if (WaitForSingleObject(handle, 0) == WAIT_OBJECT_0) return IntPtr.Zero; // already exited
            string image = ImagePath(handle);
            string sid = TokenUserSid(handle);
            if (sid == null) { entry = new Entry { Pid = pid, Created = created, Image = image, Reason = "token_unreadable" }; return IntPtr.Zero; }
            if (!string.Equals(sid, mySid, StringComparison.OrdinalIgnoreCase)) return IntPtr.Zero;
            string environment = ReadEnvironment(handle);
            if (environment == null) { entry = new Entry { Pid = pid, Created = created, Image = image, Reason = "environment_unreadable" }; return IntPtr.Zero; }
            if (!HasMark(environment, markName, markValue)) return IntPtr.Zero;
            // Marked: this owner's process. What follows decides only whether it may be ended; a fact that cannot be
            // read sets a reason, and the caller then counts it as not ended (the sweep is unproven).
            entry = new Entry { Pid = pid, Created = created, Image = image };
            bool inJob;
            if (!IsProcessInJob(handle, IntPtr.Zero, out inJob)) entry.Reason = "job_unreadable";
            entry.InJob = inJob;
            uint length = 0;
            int packageResult = GetPackageFullName(handle, ref length, null);
            entry.Packaged = packageResult == ERROR_INSUFFICIENT_BUFFER;
            if (packageResult != APPMODEL_ERROR_NO_PACKAGE && !entry.Packaged && entry.Reason == null) entry.Reason = "package_unreadable";
            keep = true;
            return handle;
        }
        finally { if (!keep) CloseHandle(handle); }
    }

    private static long CreationTime(IntPtr handle)
    {
        long creation, exit, kernel, user;
        return GetProcessTimes(handle, out creation, out exit, out kernel, out user) ? creation : 0;
    }

    private static string ImagePath(IntPtr handle)
    {
        var buffer = new StringBuilder(1024);
        uint size = (uint)buffer.Capacity;
        return QueryFullProcessImageNameW(handle, 0, buffer, ref size) ? buffer.ToString() : "";
    }

    private static string TokenUserSid(IntPtr handle)
    {
        IntPtr token;
        if (!OpenProcessToken(handle, TOKEN_QUERY, out token)) return null;
        IntPtr info = IntPtr.Zero;
        try
        {
            int needed;
            GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out needed);
            if (needed <= 0) return null;
            info = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, TokenUser, info, needed, out needed)) return null;
            IntPtr text;
            if (!ConvertSidToStringSidW(Marshal.ReadIntPtr(info), out text)) return null;
            try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
        }
        finally
        {
            if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
            CloseHandle(token);
        }
    }

    private static string ReadEnvironment(IntPtr handle)
    {
        var basic = new PROCESS_BASIC_INFORMATION();
        int returned;
        if (NtQueryInformationProcess(handle, ProcessBasicInformation, ref basic, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) != 0) return null;
        if (basic.PebBaseAddress == IntPtr.Zero) return null;
        IntPtr parameters = ReadPointer(handle, basic.PebBaseAddress + PebProcessParametersOffset);
        if (parameters == IntPtr.Zero) return null;
        IntPtr environment = ReadPointer(handle, parameters + ParametersEnvironmentOffset);
        long size = (long)ReadPointer(handle, parameters + ParametersEnvironmentSizeOffset);
        if (environment == IntPtr.Zero || size <= 0 || size > MaxEnvironmentBytes || size % 2 != 0) return null;
        var bytes = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(handle, environment, bytes, new IntPtr(size), out read) || (long)read != size) return null;
        return Encoding.Unicode.GetString(bytes);
    }

    private static IntPtr ReadPointer(IntPtr handle, IntPtr address)
    {
        var bytes = new byte[8];
        IntPtr read;
        if (!ReadProcessMemory(handle, address, bytes, new IntPtr(8), out read) || (long)read != 8) return IntPtr.Zero;
        return new IntPtr(BitConverter.ToInt64(bytes, 0));
    }

    // Exact entry match: the name compared as Windows does (ordinal, ignoring case), the value byte for byte.
    public static bool HasMark(string environment, string markName, string markValue)
    {
        foreach (string item in environment.Split('\0'))
        {
            if (item.Length == 0) break;
            int equals = item.IndexOf('=', 1);
            if (equals <= 0) continue;
            if (string.Equals(item.Substring(0, equals), markName, StringComparison.OrdinalIgnoreCase)
                && string.Equals(item.Substring(equals + 1), markValue, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static List<uint> SnapshotProcessIds()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateToolhelp32Snapshot");
        var pids = new List<uint>();
        try
        {
            var entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Process32First");
            do { pids.Add(entry.th32ProcessID); } while (Process32NextW(snapshot, ref entry));
        }
        finally { CloseHandle(snapshot); }
        return pids;
    }

    private static void AppendEntries(StringBuilder json, IEnumerable<Entry> entries)
    {
        json.Append('[');
        bool first = true;
        foreach (Entry entry in entries)
        {
            if (!first) json.Append(',');
            first = false;
            json.Append("{\"pid\":").Append(entry.Pid).Append(",\"created\":\"").Append(entry.Created).Append('"');
            json.Append(",\"image\":\"").Append(JsonEscape(entry.Image)).Append('"');
            json.Append(",\"packaged\":").Append(entry.Packaged ? "true" : "false");
            json.Append(",\"inJob\":").Append(entry.InJob ? "true" : "false");
            if (entry.Reason != null) json.Append(",\"reason\":\"").Append(JsonEscape(entry.Reason)).Append('"');
            json.Append('}');
        }
        json.Append(']');
    }

    private static string JsonEscape(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
            else builder.Append(c);
        }
        return builder.ToString();
    }
}
'@

# PX-2a: load the Job-host helper from a precompiled, digest-pinned assembly
# when the host provides one over the private stdin config. The file bytes are
# read once into memory, hashed, and loaded FROM THOSE BYTES
# ([Reflection.Assembly]::Load(byte[])), so the file cannot be swapped between
# check and load. On a missing file, a digest mismatch, or a load error the
# assembly is never loaded: this falls back to compiling the same source
# in-process (today's Add-Type behavior) and records why in the Job event
# file. A valid assembly without the expected type falls back the same way
# (`missing-type`). One PowerShell host per call, one Job per call, and every
# proof below are unchanged.
function Initialize-JobHostType {
    param($HelperAssemblyPath, $HelperAssemblySha256, $EventPath)
    $script:jobHostHelperMode = "fallback"
    $script:jobHostHelperReason = "no-helper-config"
    $helperPath = [string]$HelperAssemblyPath
    $helperDigest = [string]$HelperAssemblySha256
    if (-not [string]::IsNullOrWhiteSpace($helperPath) -and -not [string]::IsNullOrWhiteSpace($helperDigest)) {
        $haveBytes = $false
        $helperBytes = $null
        try {
            $helperBytes = [IO.File]::ReadAllBytes($helperPath)
            $haveBytes = $true
        } catch {
            $script:jobHostHelperReason = "missing-file"
        }
        if ($haveBytes) {
            $hasher = [Security.Cryptography.SHA256]::Create()
            try {
                $actualDigest = ([BitConverter]::ToString($hasher.ComputeHash($helperBytes))).Replace("-", "").ToLowerInvariant()
            } finally {
                $hasher.Dispose()
            }
            if ($actualDigest -cne $helperDigest.ToLowerInvariant()) {
                $script:jobHostHelperReason = "digest-mismatch"
            } else {
                try {
                    [Reflection.Assembly]::Load($helperBytes) | Out-Null
                    # N5: a valid assembly without the expected type must fall
                    # back like any other load-side failure, not exit 1 below
                    # on `Unable to find type [ManagedProcessJobHost]`.
                    if ($null -eq ('ManagedProcessJobHost' -as [type])) {
                        $script:jobHostHelperReason = "missing-type"
                    } else {
                        $script:jobHostHelperMode = "precompiled"
                        $script:jobHostHelperReason = $null
                    }
                } catch {
                    $script:jobHostHelperReason = "load-error"
                }
            }
        }
        if ($script:jobHostHelperMode -ne "precompiled") {
            Add-Type -TypeDefinition $jobHostCsSource
        }
    } else {
        Add-Type -TypeDefinition $jobHostCsSource
    }
    try {
        if (-not [string]::IsNullOrWhiteSpace([string]$EventPath)) {
            if ($null -eq $script:jobHostHelperReason) {
                $reasonJson = "null"
            } else {
                $reasonJson = '"' + ([string]$script:jobHostHelperReason).Replace("\", "\\").Replace('"', '\"') + '"'
            }
            [IO.File]::AppendAllText([string]$EventPath,
                '{"type":"helper","mode":"' + $script:jobHostHelperMode + '","reason":' + $reasonJson + '}' + [Environment]::NewLine,
                [Text.UTF8Encoding]::new($false))
        }
    } catch {
    }
}

if ($args.Count -eq 1 -and $args[0] -eq "--aiboard-escape-sweep") {
    # The stop-time escape sweep (ManagedProcessEscapeSweep). One config line on stdin; "ready" once the helper is
    # loaded, then one JSON line: the report, or {"error": ...} with exit 1. It creates no process.
    try {
        $sweep = [Console]::In.ReadLine() | ConvertFrom-Json
        if ($null -eq $sweep -or [string]::IsNullOrWhiteSpace([string]$sweep.markName) -or [string]::IsNullOrWhiteSpace([string]$sweep.markValue)) {
            throw "Escape sweep config is incomplete."
        }
        Initialize-JobHostType -HelperAssemblyPath $sweep.helperAssemblyPath -HelperAssemblySha256 $sweep.helperAssemblySha256 -EventPath $null
        [Console]::Out.WriteLine("ready")
        [Console]::Out.Flush()
        $report = [ManagedProcessEscapeSweep]::Sweep([string]$sweep.markName, [string]$sweep.markValue, [long][string]$sweep.since,
            [int]$sweep.exitWaitMs, [int]$sweep.maxRounds, [string]$sweep.injectedFault)
        [Console]::Out.WriteLine($report)
        [Console]::Out.Flush()
        exit 0
    } catch {
        $message = ([string]$_.Exception.Message).Replace("\", "\\").Replace('"', '\"').Replace("`r", " ").Replace("`n", " ")
        [Console]::Out.WriteLine('{"error":"' + $message + '"}')
        [Console]::Out.Flush()
        exit 1
    }
}

if ($args.Count -eq 1 -and $args[0] -eq "--aiboard-lsp-pipe") {
    # R2: until RunInteractive is entered no process can have been created, so a failure here says "launched": false.
    # A failure that escapes RunInteractive (its own error line could not be written) does not: it may have run one.
    $runInteractiveEntered = $false
    try {
        $bootstrap = [Console]::In.ReadLine()
        if ([string]::IsNullOrWhiteSpace($bootstrap)) {
            throw "LSP Job Object bootstrap is missing."
        }
        $envelope = $bootstrap | ConvertFrom-Json
        if ($envelope.encoding -ne "base64-utf8-json" -or [string]::IsNullOrWhiteSpace([string]$envelope.payload)) {
            throw "LSP Job Object bootstrap encoding is invalid."
        }
        $configuration = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String([string]$envelope.payload)
        ) | ConvertFrom-Json
        if ($null -eq $configuration.command -or $null -eq $configuration.cwd -or $null -eq $configuration.env) {
            throw "LSP Job Object bootstrap is incomplete."
        }
        $environment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($property in $configuration.env.PSObject.Properties) {
            $environment[$property.Name] = [string]$property.Value
        }
        Initialize-JobHostType -HelperAssemblyPath $configuration.helperAssemblyPath -HelperAssemblySha256 $configuration.helperAssemblySha256 -EventPath $configuration.eventPath
        $runInteractiveEntered = $true
        $exitCode = [ManagedProcessJobHost]::RunInteractive(
            [string]$configuration.command,
            [string[]]@($configuration.args | ForEach-Object { [string]$_ }),
            [string]$configuration.cwd,
            $environment,
            [string]$configuration.eventPath,
            [string]$configuration.injectedFault
        )
        exit $exitCode
    } catch {
        $launchedField = if ($runInteractiveEntered) { '' } else { ',"launched":false' }
        $bootstrapError = '{"type":"error","pid":0,"exitCode":null,"activeProcesses":0,"error":"LSP Job Object bootstrap failed."' + $launchedField + '}'
        if ($runInteractiveEntered -and [string]$configuration.injectedFault -eq "started_emit_unwritable") {
            # Stricter-only test fault: the event file stays unwritable for this line too, so the host ends silent.
        } elseif ($null -ne $configuration -and -not [string]::IsNullOrWhiteSpace([string]$configuration.eventPath)) {
            [IO.File]::AppendAllText([string]$configuration.eventPath, $bootstrapError + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        } else {
            [Console]::Error.WriteLine('@aiboard-lsp-job-host:' + $bootstrapError)
            [Console]::Error.Flush()
        }
        exit 1
    }
}

$configuration = [Console]::In.ReadLine() | ConvertFrom-Json
$environment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($property in $configuration.env.PSObject.Properties) {
    $environment[$property.Name] = [string]$property.Value
}
Initialize-JobHostType -HelperAssemblyPath $configuration.helperAssemblyPath -HelperAssemblySha256 $configuration.helperAssemblySha256 -EventPath $configuration.eventPath
$exitCode = [ManagedProcessJobHost]::Run(
    [string]$configuration.command,
    [string[]]@($configuration.args),
    [string]$configuration.cwd,
    $environment,
    [string]$configuration.stdoutPath,
    [string]$configuration.stderrPath,
    [string]$configuration.injectedFault
)
exit $exitCode

$ErrorActionPreference = 'Stop'
try {
    # The Runner supplies this only to an owned, still-authorized helper.
    $EncodedTarget = [Console]::ReadLine()
    if ([string]::IsNullOrWhiteSpace($EncodedTarget) -or $EncodedTarget.Length -gt 4096) { exit 64 }
    $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedTarget)) | ConvertFrom-Json
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AIBoardCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int length, out int needed);
    public static bool IsCurrentDesktop(IntPtr input) {
        var currentName = new StringBuilder(256);
        var inputName = new StringBuilder(256);
        int needed;
        return GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, currentName, currentName.Capacity * 2, out needed)
            && GetUserObjectInformation(input, 2, inputName, inputName.Capacity * 2, out needed)
            && String.Equals(currentName.ToString(), inputName.ToString(), StringComparison.OrdinalIgnoreCase);
    }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder title, int count);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int key, out Rect value, int length);
}
'@
    if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        throw 'Screenshot capture requires an interactive Windows desktop.'
    }
    $desktop = [AIBoardCapture]::OpenInputDesktop(0, $false, 1)
    if ($desktop -eq [IntPtr]::Zero) { throw 'Unlock the interactive desktop before capturing a screenshot.' }
    try {
        if (-not [AIBoardCapture]::IsCurrentDesktop($desktop)) { throw 'Unlock the interactive desktop before capturing a screenshot.' }
        [void][AIBoardCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
        $oldDpi = [AIBoardCapture]::SetThreadDpiAwarenessContext([IntPtr](-4))
        if ($oldDpi -eq [IntPtr]::Zero) { throw 'Windows could not enable native-resolution capture.' }
        Add-Type -AssemblyName System.Drawing
        Add-Type -AssemblyName System.Windows.Forms
        $screens = [Windows.Forms.Screen]::AllScreens
        switch ($target.target) {
            'monitor' {
                if ($null -eq $target.monitor) {
                    $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
                } else {
                    if ($target.monitor -ge $screens.Length) { throw 'Monitor index is out of range.' }
                    $bounds = $screens[[int]$target.monitor].Bounds
                }
            }
            'window' {
                $window = [AIBoardCapture]::GetForegroundWindow()
                $title = New-Object Text.StringBuilder 4096
                [void][AIBoardCapture]::GetWindowText($window, $title, $title.Capacity)
                if ($title.ToString().IndexOf([string]$target.windowTitle, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                    throw 'Bring the window matching windowTitle to the foreground and try again.'
                }
                $rectangle = New-Object AIBoardCapture+Rect
                if ([AIBoardCapture]::DwmGetWindowAttribute($window, 9, [ref]$rectangle, 16) -ne 0) {
                    throw 'Windows could not determine the visible window bounds.'
                }
                $bounds = [Drawing.Rectangle]::FromLTRB($rectangle.Left, $rectangle.Top, $rectangle.Right, $rectangle.Bottom)
            }
            'region' { $bounds = New-Object Drawing.Rectangle ([int]$target.x), ([int]$target.y), ([int]$target.width), ([int]$target.height) }
            default { throw 'Invalid screenshot target.' }
        }
        $outside = New-Object Drawing.Region $bounds
        try {
            foreach ($screen in $screens) { $outside.Exclude($screen.Bounds) }
            $matrix = New-Object Drawing.Drawing2D.Matrix
            try {
                if ($outside.GetRegionScans($matrix).Length -gt 0) { throw 'The capture area must be fully visible on the desktop.' }
            } finally { $matrix.Dispose() }
        } finally { $outside.Dispose() }
        if ($bounds.Width -lt 1 -or $bounds.Height -lt 1 -or $bounds.Width -gt 20000 -or $bounds.Height -gt 20000 -or
            [long]$bounds.Width * $bounds.Height -gt 50000000) { throw 'The capture area exceeds the screenshot pixel limit.' }
        $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                if ($target.target -eq 'window' -and [AIBoardCapture]::GetForegroundWindow() -ne $window) {
                    throw 'The foreground window changed before the screenshot.'
                }
                $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
                if ($target.target -eq 'window' -and [AIBoardCapture]::GetForegroundWindow() -ne $window) {
                    throw 'The foreground window changed during the screenshot.'
                }
            } finally { $graphics.Dispose() }
            $stream = New-Object IO.MemoryStream
            try {
                $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
                if ($stream.Length -gt 20971520) { throw 'The original screenshot exceeds 20 MiB.' }
                [Console]::WriteLine([Convert]::ToBase64String($stream.ToArray()))
            } finally { $stream.Dispose() }
        } finally { $bitmap.Dispose() }
    } finally { [void][AIBoardCapture]::CloseDesktop($desktop) }
} catch {
    [Console]::Error.WriteLine('AIBOARD_CAPTURE: ' + $_.Exception.Message)
    exit 1
}

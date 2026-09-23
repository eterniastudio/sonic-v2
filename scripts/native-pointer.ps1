param([long]$WindowHandle, [int]$StartX, [int]$StartY, [int]$EndX, [int]$EndY, [switch]$Drag)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SonicPointer {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[SonicPointer]::SetProcessDPIAware() | Out-Null
[SonicPointer]::SetForegroundWindow([IntPtr]$WindowHandle) | Out-Null
$focusDeadline = [DateTime]::UtcNow.AddSeconds(3)
while ([SonicPointer]::GetForegroundWindow().ToInt64() -ne $WindowHandle) {
  if ([DateTime]::UtcNow -gt $focusDeadline) { throw 'The test window could not receive foreground input.' }
  Start-Sleep -Milliseconds 10
}
[SonicPointer]::SetCursorPos($StartX, $StartY) | Out-Null
# Deliberate pointer dwell and button duration are part of the input gesture.
Start-Sleep -Milliseconds 80
[SonicPointer]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
if ($Drag) {
  for ($index = 1; $index -le 10; $index++) {
    [SonicPointer]::SetCursorPos(($StartX + ($EndX - $StartX) * $index / 10), ($StartY + ($EndY - $StartY) * $index / 10)) | Out-Null
    Start-Sleep -Milliseconds 16
  }
}
Start-Sleep -Milliseconds 30
[SonicPointer]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)

param([ValidateSet('Snapshot','Terminate')][string]$Mode = 'Snapshot', [int]$TargetPid = 0, [string]$ExpectedCreationTicks = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SonicTestProcessHandle {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static long Birth(IntPtr handle) {
    FileTime created, exited, kernel, user;
    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new InvalidOperationException("Cannot inspect process creation time.");
    return ((long)created.High << 32) | created.Low;
  }
  public static string Created(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) return null;
    try { return Birth(handle).ToString(); } finally { CloseHandle(handle); }
  }
  public static bool TerminateExact(int pid, string expected) {
    // Creation verification and termination use the SAME kernel handle.
    IntPtr handle = OpenProcess(0x1001, false, pid);
    if (handle == IntPtr.Zero) return false;
    try {
      if (Birth(handle).ToString() != expected) return false;
      if (!TerminateProcess(handle, 137)) throw new InvalidOperationException("Termination failed for verified process handle.");
      return true;
    } finally { CloseHandle(handle); }
  }
}
'@
if ($Mode -eq 'Terminate') {
  if ($TargetPid -le 0 -or $ExpectedCreationTicks -notmatch '^\d+$') { throw 'Exact process identity is required.' }
  @{ terminated = [SonicTestProcessHandle]::TerminateExact($TargetPid, $ExpectedCreationTicks); pid = $TargetPid; expectedCreationTicks = $ExpectedCreationTicks } | ConvertTo-Json -Compress
} else {
  $entries = @(foreach ($entry in Get-CimInstance Win32_Process) {
    try {
      $ticks = [SonicTestProcessHandle]::Created([int]$entry.ProcessId)
      if (!$ticks -or !$entry.CreationDate) { continue }
      # CIM timestamps can truncate sub-microsecond precision. Reject a stale
      # CIM identity if its PID was replaced before the kernel-handle query.
      $cimTicks = $entry.CreationDate.ToUniversalTime().ToFileTimeUtc()
      if ([math]::Abs(([decimal]$ticks - [decimal]$cimTicks)) -ge 10) { continue }
      [pscustomobject]@{ ProcessId = [int]$entry.ProcessId; ParentProcessId = [int]$entry.ParentProcessId; CreationTicks = $ticks; CreationDate = $entry.CreationDate; Name = $entry.Name; CommandLine = $entry.CommandLine }
    } catch { continue }
  })
  ConvertTo-Json -InputObject $entries -Compress
}

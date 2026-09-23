/** Fail closed: numeric ancestry alone is not ownership (Windows reuses PIDs). */
export function creationTicks(entry) {
  try { return /^\d+$/.test(entry?.CreationTicks ?? '') ? BigInt(entry.CreationTicks) : null } catch { return null }
}
export function sameProcess(a, b) {
  const left = creationTicks(a), right = creationTicks(b)
  return left !== null && right !== null && left === right && a.ProcessId === b.ProcessId
}
function hasCommand(entry) { return typeof entry?.CommandLine === 'string' && entry.CommandLine.trim().length > 0 }
function matchesProfile(entry, profile) {
  if (!hasCommand(entry)) return false
  const command = entry.CommandLine.replaceAll('/', '\\').toLowerCase()
  const target = profile.replaceAll('/', '\\').toLowerCase()
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Bind the path to this option; merely mentioning it in another argument
  // cannot authorize a process using some other profile.
  return new RegExp(`(?:^|["\\s])--user-data-dir=(?:"${escaped}"|${escaped}(?=["\\s]|$))`).test(command)
}
export function establishAnchors(table, { mainPid, launcherPid, profile, launchedAfter }) {
  const main = table.find(entry => entry.ProcessId === mainPid)
  const launcher = table.find(entry => entry.ProcessId === launcherPid)
  const earliest = BigInt(launchedAfter)
  if (!main || !launcher || !matchesProfile(main, profile) || !matchesProfile(launcher, profile)) throw new Error('Cannot prove isolated profile ownership of main/launcher.')
  const mt = creationTicks(main), lt = creationTicks(launcher)
  if (mt === null || lt === null || mt < earliest || lt < earliest || mt < lt) throw new Error('Cannot prove creation-time ownership of main/launcher.')
  if (mainPid !== launcherPid && main.ParentProcessId !== launcherPid) throw new Error('Actual main is not a direct child of its validated launcher.')
  return mainPid === launcherPid ? [main] : [launcher, main]
}
export function selectOwnedProcesses(table, anchors, previouslyOwned = []) {
  const selected = []
  // Previously proven identities remain ours even after their parent exits.
  for (const known of [...anchors, ...previouslyOwned]) {
    const current = table.find(entry => sameProcess(entry, known))
    if (current && hasCommand(current) && !selected.some(entry => sameProcess(entry, current))) selected.push(current)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const child of table) {
      const born = creationTicks(child)
      if (born === null || !hasCommand(child) || selected.some(entry => sameProcess(entry, child))) continue
      const parent = selected.find(entry => entry.ProcessId === child.ParentProcessId)
      if (parent && born >= creationTicks(parent)) { selected.push(child); changed = true }
    }
  }
  return selected
}
export function youngestFirst(entries) { return [...entries].sort((a, b) => creationTicks(a) > creationTicks(b) ? -1 : creationTicks(a) < creationTicks(b) ? 1 : 0) }

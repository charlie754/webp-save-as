/**
 * Shutting down a Firefox launched for a test, and actually deleting its profile.
 *
 * Two traps, both of which silently leaked ~100 MB of %TEMP% per run before this existed:
 *
 *  1. On Windows the process we spawn is only a launcher — it hands off to the real browser and
 *     exits. `child.kill()` therefore often kills something that is already gone, leaving Firefox
 *     running and the profile locked. The browser has to be found by the profile path it was
 *     given.
 *  2. Even once the browser is gone, the lock lingers for a moment, so `rm()` throws EBUSY. That
 *     error must be retried and, if it still fails, reported rather than swallowed.
 */
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

/** Kill any Firefox that was started with `--profile <profile>`, whoever its parent is. */
function killBrowsersUsingProfile(profile) {
  if (process.platform === 'win32') {
    const quoted = profile.replace(/'/g, "''");
    spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\"" +
      ` | Where-Object { $_.CommandLine -like '*${quoted}*' }` +
      ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ], { stdio: 'ignore' });
    return;
  }
  spawnSync('pkill', ['-f', profile], { stdio: 'ignore' });
}

/**
 * Stop the browser and remove its throwaway profile.
 * @returns {Promise<boolean>} false if the profile is still on disk, having said so on stderr.
 */
export async function shutdownFirefox(child, profile, options = {}) {
  const attempts = options.attempts || 12;
  const waitMs = options.waitMs || 500;

  if (child) {
    try { child.kill(); } catch { /* already gone */ }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
    }
  }
  killBrowsersUsingProfile(profile);

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 3 });
      return true;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  console.warn('\nWARNING: the temporary profile could not be deleted (' +
    (lastError && lastError.code) + '). Remove it by hand:\n  ' + profile);
  return false;
}

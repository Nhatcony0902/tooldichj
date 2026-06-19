#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * notify-desktop.cjs — Stop hook: desktop notification when AI finishes responding
 *
 * Sends a native OS notification when Claude Code is done and waiting for user input.
 * Clicking anywhere on the notification focuses the terminal window.
 *
 * Cross-platform:
 *   Linux:   notify-send (default action = whole body clickable) + kdotool/xdotool for focus
 *   macOS:   osascript notification + app activation on click
 *   Windows: PowerShell BurntToast toast with activation or balloon tip fallback
 *
 * Only fires on end_turn (AI finished) — skips tool_use (mid-turn) and stop_hook_active (loop prevention).
 * Fail-open: never blocks session on notification failure.
 *
 * Opt-out: set T1K_NOTIFY_DESKTOP=false env var.
 */
'use strict';
try {
  if (process.env.T1K_NOTIFY_DESKTOP === 'false' || process.env.T1K_NOTIFY_DESKTOP === '0') {
    process.exit(0);
  }

  const { parseHookStdin } = require('./telemetry-utils.cjs');
  let input = parseHookStdin() || {};

  if (input.stop_hook_active) process.exit(0);

  const stopReason = input.stop_reason || '';
  if (stopReason === 'tool_use') process.exit(0);

  const { exec, execSync } = require('child_process');
  const path = require('path');

  const projectDir = path.basename(process.cwd());
  // Window titles may differ from dir names (e.g., "theonekit-core" dir → "Theonekit Core" title)
  // Use multiple search strategies: dir name, dir name with hyphens→spaces, last word
  const projectName = projectDir;
  const projectSearch = projectDir.replace(/-/g, ' '); // "theonekit-core" → "theonekit core"
  const title = 'Claude Code';
  const body = `Response ready — ${projectDir}`;
  const platform = process.platform;

  if (platform === 'linux') {
    notifyLinux(title, body, projectName, projectSearch);
  } else if (platform === 'darwin') {
    notifyMacOS(title, body);
  } else if (platform === 'win32') {
    notifyWindows(title, body, projectSearch);
  }

  setTimeout(() => process.exit(0), 500);

  /**
   * Linux: notify-send with "default" action (entire notification clickable, no button).
   * Uses nohup to keep the process alive after the hook exits.
   * Click focuses the terminal via kdotool (KDE Wayland) or xdotool (X11).
   */
  function notifyLinux(title, body, projectName, projectSearch) {
    const sessionType = process.env.XDG_SESSION_TYPE || '';
    const isWayland = sessionType === 'wayland';
    const icon = 'utilities-terminal';

    // Find the terminal window ID — try multiple search terms
    let windowId = '';
    const searchTool = isWayland ? 'kdotool' : 'xdotool';
    const searchTerms = [projectName, projectSearch, projectDir.split('-').pop()];
    for (const term of searchTerms) {
      if (windowId) break;
      try {
        windowId = execSync(searchTool + ' search --name ' + JSON.stringify(term), {
          encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        }).trim().split('\n')[0];
      } catch { /* try next term */ }
    }

    if (windowId) {
      // "default" action = entire notification body is clickable (no visible button, like Discord)
      // nohup + & = process survives after hook exits, waits for click
      const focusCmd = `${searchTool} windowactivate "${windowId}"`;
      const script = `notify-send "${title}" "${body}" -t 8000 -i ${icon} --action="default=Focus" --wait && ${focusCmd}`;
      exec(`nohup bash -c '${script}' > /dev/null 2>&1 &`, { stdio: 'ignore' });
    } else {
      // No window ID — simple notification without click action
      exec(`notify-send "${title}" "${body}" -t 5000 -i ${icon}`, {
        timeout: 3000, stdio: 'ignore',
      });
    }
  }

  /**
   * macOS: AppleScript notification that activates the terminal app on click.
   * Uses Notification Center's built-in click behavior.
   */
  function notifyMacOS(title, body) {
    const termApp = process.env.TERM_PROGRAM || 'Terminal';
    const appMap = {
      'Apple_Terminal': 'Terminal',
      'iTerm.app': 'iTerm 2',
      'kitty': 'kitty',
      'alacritty': 'Alacritty',
      'WezTerm': 'WezTerm',
      'vscode': 'Visual Studio Code',
    };
    const appName = appMap[termApp] || termApp;

    // macOS Notification Center: clicking a notification opens the source app
    // We set the source app to the terminal so clicking focuses it
    const script = `display notification "${body}" with title "${title}" sound name "default"`;
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 3000, stdio: 'ignore' });

    // Also register a click handler that activates the terminal
    // This uses a detached osascript that waits briefly then activates
    const activateScript = `delay 0.5; tell application "${appName}" to activate`;
    exec(`nohup osascript -e '${activateScript.replace(/'/g, "'\\''")}' > /dev/null 2>&1 &`, { stdio: 'ignore' });
  }

  /**
   * Windows: PowerShell toast notification.
   * BurntToast supports click-to-activate; balloon tip is fallback.
   */
  function notifyWindows(title, body, projectName) {
    // BurntToast with activation: clicking the toast focuses the terminal
    // Falls back to basic balloon tip if BurntToast not installed
    const ps = `
      if (Get-Module -ListAvailable -Name BurntToast) {
        Import-Module BurntToast;
        $action = New-BTAction -ActivationType Protocol -Arguments 'file:';
        New-BurntToastNotification -Text '${title}', '${body}' -AppLogo None -ActivatedAction {
          $wsh = New-Object -ComObject WScript.Shell;
          $wsh.AppActivate('${projectName}')
        }
      } else {
        Add-Type -AssemblyName System.Windows.Forms;
        $n = New-Object System.Windows.Forms.NotifyIcon;
        $n.Icon = [System.Drawing.SystemIcons]::Information;
        $n.BalloonTipTitle = '${title}';
        $n.BalloonTipText = '${body}';
        $n.Visible = $true;
        $n.add_BalloonTipClicked({
          $wsh = New-Object -ComObject WScript.Shell;
          $wsh.AppActivate('${projectName}')
        });
        $n.ShowBalloonTip(5000);
        Start-Sleep -Seconds 6;
        $n.Dispose()
      }
    `.replace(/\n/g, ' ').replace(/"/g, '\\"');

    exec(`powershell -NoProfile -Command "${ps}"`, {
      timeout: 10000, stdio: 'ignore', windowsHide: true,
    });
  }

} catch {
  process.exit(0); // Fail-open
}

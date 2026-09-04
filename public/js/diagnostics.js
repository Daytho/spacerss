/**
 * On-screen error reporting.
 *
 * Loaded as a classic script (not a module) so it runs before the module
 * scripts and is in place to catch their failures — including module resolution
 * errors, which happen before any module code executes.
 *
 * A phone has no developer console, so a broken page there is otherwise just a
 * blank scene with an unexplained loading message. This puts the actual error on
 * the screen where it can be read and reported.
 */
(function installDiagnostics() {
  var panel = null;
  var seen = {};

  function show(kind, message, detail) {
    if (seen[message]) return;
    seen[message] = true;

    if (!panel) {
      panel = document.createElement('div');
      panel.setAttribute('role', 'alert');
      panel.style.cssText = [
        'position:fixed', 'left:12px', 'right:12px', 'bottom:12px',
        'z-index:9999', 'max-height:52vh', 'overflow:auto',
        'padding:12px 14px', 'border-radius:4px',
        'border:1px solid rgba(224,71,63,0.55)',
        'border-left:3px solid #e0473f',
        'background:rgba(18,8,10,0.94)', 'color:#e7dede',
        'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        'white-space:pre-wrap', 'word-break:break-word',
      ].join(';');

      var close = document.createElement('button');
      close.textContent = '×';
      close.style.cssText = 'position:absolute;top:6px;right:10px;background:none;'
        + 'border:none;color:#9a8f8f;font-size:18px;cursor:pointer;line-height:1';
      close.addEventListener('click', function () { panel.remove(); panel = null; });
      panel.appendChild(close);

      var title = document.createElement('div');
      title.textContent = 'SpaceRSS could not start';
      title.style.cssText = 'color:#e0473f;font-weight:700;letter-spacing:0.06em;'
        + 'text-transform:uppercase;font-size:11px;margin-bottom:8px';
      panel.appendChild(title);

      (document.body || document.documentElement).appendChild(panel);
    }

    var line = document.createElement('div');
    line.style.cssText = 'margin-top:6px';
    line.textContent = kind + ': ' + message + (detail ? '\n  ' + detail : '');
    panel.appendChild(line);
  }

  window.addEventListener('error', function (e) {
    if (e.message) {
      show('Error', e.message, e.filename ? e.filename + ':' + e.lineno : '');
    } else if (e.target && e.target.src) {
      // A failed <script>/<link> load fires an error event with no message.
      show('Failed to load', e.target.src, '');
    }
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show('Unhandled rejection', (r && (r.message || r)) + '', r && r.stack ? '' : '');
  });

  // Report a missing WebGL context explicitly: the scene cannot build without
  // one, and the resulting exception is far less clear than saying so.
  window.addEventListener('DOMContentLoaded', function () {
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
        || canvas.getContext('experimental-webgl');
      if (!gl) {
        show('WebGL unavailable', 'This browser reports no WebGL context, so the 3D '
          + 'view cannot render.', 'On iOS check Settings > Apps > Safari > Advanced > '
          + 'Experimental Features > WebGL, or try another browser.');
      }
    } catch (err) {
      show('WebGL check failed', err && err.message ? err.message : String(err), '');
    }
  });
}());

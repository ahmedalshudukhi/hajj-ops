// voice.js — generic Web Speech API helper. Auto-binds to any element
// with data-voice-target="<input/textarea id>" attribute.
//
// Usage in HTML:
//   <button data-voice-target="myNotes">🎤 Dictate</button>
//   <textarea id="myNotes"></textarea>
//
// The helper:
//   - hides itself when SpeechRecognition is unavailable
//   - shows real-time interim transcript as button text
//   - appends final text to the target field (preserves existing content)
//   - supports start/stop toggling on the same button
//   - sets data-listening attr while active for CSS styling
(function() {
  if (window.CADVoice) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function bindOne(btn) {
    if (btn._cadVoiceBound) return;
    btn._cadVoiceBound = true;
    if (!SR) {
      btn.disabled = true;
      btn.title = 'Speech recognition not supported in this browser';
      btn.style.opacity = '0.45';
      return;
    }
    const targetId = btn.getAttribute('data-voice-target');
    let recognition = null;
    let listening = false;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = document.getElementById(targetId);
      if (!target) return;
      if (listening && recognition) { try { recognition.stop(); } catch (_) {} return; }
      const lang = btn.getAttribute('data-voice-lang') || 'en-US';
      recognition = new SR();
      recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;
      let finalText = '';
      const origText = btn.textContent;
      recognition.onstart = () => {
        listening = true;
        btn.setAttribute('data-listening', '1');
        btn.textContent = '⏹ Stop';
        btn.style.background = 'rgba(239,68,68,0.2)';
        btn.style.color = '#fca5a5';
      };
      recognition.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript + ' ';
          else interim += ev.results[i][0].transcript;
        }
        btn.textContent = '🎤 ' + (interim || finalText).trim().slice(0, 40);
      };
      recognition.onerror = (ev) => {
        listening = false;
        btn.textContent = origText;
        btn.removeAttribute('data-listening');
        btn.style.background = '';
        btn.style.color = '';
        console.warn('voice error:', ev.error);
      };
      recognition.onend = () => {
        listening = false;
        btn.textContent = origText;
        btn.removeAttribute('data-listening');
        btn.style.background = '';
        btn.style.color = '';
        if (finalText) {
          const cur = target.value || '';
          target.value = (cur ? cur + ' ' : '') + finalText.trim();
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.focus();
        }
      };
      try { recognition.start(); } catch (e) { console.error('voice start failed', e); }
    });
  }

  function scan() {
    document.querySelectorAll('[data-voice-target]').forEach(bindOne);
  }

  document.addEventListener('DOMContentLoaded', scan);
  // Also re-scan on dynamic DOM (e.g. modals open) via MutationObserver
  if (window.MutationObserver) {
    const obs = new MutationObserver(() => scan());
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  window.CADVoice = { scan, supported: !!SR };
})();

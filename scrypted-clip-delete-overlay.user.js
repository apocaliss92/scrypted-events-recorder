// ==UserScript==
// @name         Scrypted - delete button on recorded clip thumbnails
// @description  Adds a small delete button over each RECORDED CLIPS thumbnail on
//               devices using @apocaliss92/scrypted-events-recorder, so you don't
//               have to match filenames in a dropdown by hand.
// @match        https://*/endpoint/@scrypted/core/public/*
// @grant        none
// @version      1.0
// ==/UserScript==

(function () {
  'use strict';

  // Every clip thumbnail <img> is served by this plugin's own webhook, and its
  // src already contains everything we need (deviceId + filename) as a query
  // param - no need to fetch/match anything separately.
  const THUMB_MARKER = 'videoclipThumbnail?';
  const DELETE_MARKER = 'deleteVideoclip?';

  // Positions the button over the image's own top-right corner using the
  // image's actual layout box, rather than wrapping the <img> in a new
  // element - the clip card is a flex row (img + text side by side), and
  // wrapping the image breaks that layout.
  function position(btn, img) {
    btn.style.top = (img.offsetTop + 2) + 'px';
    btn.style.left = (img.offsetLeft + img.offsetWidth - 24) + 'px';
  }

  function decorate(img) {
    if (img.dataset.deleteBtnAdded) return;
    img.dataset.deleteBtnAdded = '1';

    const parent = img.parentElement;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    const btn = document.createElement('button');
    btn.textContent = '\u{1F5D1}'; // 🗑
    btn.title = 'Delete this recorded clip';
    btn.style.cssText = [
      'position:absolute', 'z-index:9999',
      'background:rgba(0,0,0,.65)', 'color:#fff', 'border:none',
      'border-radius:4px', 'width:22px', 'height:22px', 'cursor:pointer',
      'font-size:13px', 'line-height:1', 'padding:0',
    ].join(';');
    position(btn, img);

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm('Delete this recorded clip permanently?')) return;

      btn.disabled = true;
      btn.textContent = '\u2026'; // …
      try {
        const url = img.src.replace(THUMB_MARKER, DELETE_MARKER);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

        parent.remove();
      } catch (err) {
        alert('Failed to delete clip: ' + err.message);
        btn.disabled = false;
        btn.textContent = '\u{1F5D1}';
      }
    });

    parent.appendChild(btn);
  }

  function scan() {
    document
      .querySelectorAll(`img[src*="${THUMB_MARKER}"]`)
      .forEach(decorate);
  }

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();

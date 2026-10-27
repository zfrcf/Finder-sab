(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    drop: $("drop"), file: $("file"), fileName: $("fileName"), status: $("status"),
    play: $("play"), pause: $("pause"), stop: $("stop"), prev: $("prev"), next: $("next"),
    voice: $("voice"), rate: $("rate"), rateOut: $("rateOut"), pitch: $("pitch"), pitchOut: $("pitchOut"),
    bar: $("bar"), reader: $("reader"), editor: $("editor"), editToggle: $("editToggle"),
  };

  const synth = window.speechSynthesis;
  let sentences = [];   // [{ text, el }]
  let current = 0;
  let playing = false;
  let session = 0;      // invalide les callbacks d'énoncés annulés

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };

  const setStatus = (msg) => { els.status.textContent = msg; };

  if (!synth) {
    setStatus("Votre navigateur ne prend pas en charge la synthèse vocale. Essayez Chrome, Edge ou Safari.");
  }

  /* ---------- Voix ---------- */

  function loadVoices() {
    if (!synth) return;
    const voices = synth.getVoices();
    if (!voices.length) {
      els.voice.innerHTML = '<option value="">Voix par défaut du navigateur</option>';
      return;
    }
    const saved = store.get("voix");
    const sorted = [...voices].sort((a, b) => {
      const fa = a.lang.toLowerCase().startsWith("fr") ? 0 : 1;
      const fb = b.lang.toLowerCase().startsWith("fr") ? 0 : 1;
      return fa - fb || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    });
    els.voice.innerHTML = "";
    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      els.voice.appendChild(opt);
    }
    const fallback = sorted.find((v) => v.lang.toLowerCase().startsWith("fr")) || sorted[0];
    els.voice.value = sorted.some((v) => v.voiceURI === saved) ? saved : fallback.voiceURI;
  }

  if (synth) {
    loadVoices();
    synth.addEventListener?.("voiceschanged", loadVoices);
  }

  const selectedVoice = () => synth.getVoices().find((v) => v.voiceURI === els.voice.value);

  /* ---------- Réglages ---------- */

  function initRange(input, out, key, fmt) {
    const saved = store.get(key);
    if (saved) input.value = saved;
    const sync = () => { out.textContent = fmt(+input.value); store.set(key, input.value); };
    input.addEventListener("input", sync);
    input.addEventListener("change", restartIfPlaying);
    sync();
  }
  initRange(els.rate, els.rateOut, "vitesse", (v) => v.toFixed(1) + "×");
  initRange(els.pitch, els.pitchOut, "tonalite", (v) => v.toFixed(1));
  els.voice.addEventListener("change", () => { store.set("voix", els.voice.value); restartIfPlaying(); });

  function restartIfPlaying() {
    if (playing) speakFrom(current);
  }

  /* ---------- Extraction PDF ---------- */

  async function extractPdf(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      setStatus(`Extraction du texte… page ${n} / ${pdf.numPages}`);
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push({ label: `Page ${n}`, paragraphs: itemsToParagraphs(content.items) });
    }
    return pages;
  }

  // Regroupe les fragments de texte en lignes, puis en paragraphes selon l'écart vertical.
  function itemsToParagraphs(items) {
    const lines = [];
    let line = { text: "", y: null };
    for (const it of items) {
      if (line.y === null && it.str.trim()) line.y = it.transform[5];
      line.text += it.str;
      if (it.hasEOL) { lines.push(line); line = { text: "", y: null }; }
    }
    if (line.text.trim()) lines.push(line);

    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].y !== null && lines[i - 1].y !== null) {
        const g = Math.abs(lines[i - 1].y - lines[i].y);
        if (g > 0) gaps.push(g);
      }
    }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

    const paragraphs = [];
    let buf = "";
    let prevY = null;
    for (const l of lines) {
      const t = l.text.replace(/\s+/g, " ").trim();
      const bigGap = median && prevY !== null && l.y !== null && Math.abs(prevY - l.y) > median * 1.6;
      if (!t || bigGap) {
        if (buf.trim()) paragraphs.push(buf.trim());
        buf = "";
      }
      if (t) {
        // Recolle les mots coupés en fin de ligne (« exem- ple »).
        buf = /[A-Za-zÀ-ÿ]-$/.test(buf) ? buf.slice(0, -1) + t : (buf ? buf + " " + t : t);
      }
      if (l.y !== null) prevY = l.y;
    }
    if (buf.trim()) paragraphs.push(buf.trim());
    return paragraphs;
  }

  /* ---------- Découpage en phrases ---------- */

  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter("fr", { granularity: "sentence" })
    : null;

  function splitSentences(text) {
    const raw = segmenter
      ? [...segmenter.segment(text)].map((s) => s.segment)
      : text.match(/[^.!?…]+[.!?…]+["»”)]*\s*|[^.!?…]+$/g) || [text];
    // Chrome coupe les énoncés trop longs : on fragmente au-delà de ~220 caractères.
    const out = [];
    for (const s of raw) {
      if (!s.trim()) continue;
      if (s.length <= 220) { out.push(s); continue; }
      let rest = s;
      while (rest.length > 220) {
        let cut = Math.max(rest.lastIndexOf(", ", 220), rest.lastIndexOf("; ", 220));
        if (cut < 80) cut = rest.lastIndexOf(" ", 220);
        if (cut < 80) cut = 220;
        out.push(rest.slice(0, cut + 1));
        rest = rest.slice(cut + 1);
      }
      if (rest.trim()) out.push(rest);
    }
    return out;
  }

  /* ---------- Affichage ---------- */

  function render(pages) {
    stopReading();
    sentences = [];
    current = 0;
    els.reader.innerHTML = "";
    const showLabels = pages.length > 1;
    for (const page of pages) {
      if (!page.paragraphs.length) continue;
      if (showLabels && page.label) {
        const lab = document.createElement("div");
        lab.className = "page-label";
        lab.textContent = page.label;
        els.reader.appendChild(lab);
      }
      for (const para of page.paragraphs) {
        const p = document.createElement("p");
        for (const s of splitSentences(para)) {
          const span = document.createElement("span");
          span.className = "s";
          span.textContent = s;
          span.dataset.i = sentences.length;
          sentences.push({ text: s.trim(), el: span });
          p.appendChild(span);
        }
        els.reader.appendChild(p);
      }
    }
    if (!sentences.length) {
      els.reader.innerHTML = '<p class="empty">Aucun texte trouvé. Si le PDF est une image scannée, il ne contient pas de texte lisible : collez le texte manuellement.</p>';
    }
    updateUi();
  }

  els.reader.addEventListener("click", (e) => {
    const span = e.target.closest(".s");
    if (span) speakFrom(+span.dataset.i);
  });

  function highlight(i) {
    sentences.forEach((s, k) => s.el.classList.toggle("on", k === i));
    const el = sentences[i]?.el;
    if (el) {
      const box = els.reader.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) {
        els.reader.scrollTop += r.top - box.top - box.height / 3;
      }
    }
    els.bar.style.width = sentences.length ? ((i + 1) / sentences.length) * 100 + "%" : "0";
  }

  function updateUi() {
    const has = sentences.length > 0 && !!synth;
    els.play.disabled = !has || playing;
    els.pause.disabled = !playing;
    els.stop.disabled = !has || (!playing && current === 0);
    els.prev.disabled = !has;
    els.next.disabled = !has;
    els.play.textContent = current > 0 && !playing ? "▶ Reprendre" : "▶ Lire";
  }

  /* ---------- Lecture ---------- */

  function speakFrom(i) {
    if (!synth || !sentences.length) return;
    current = Math.max(0, Math.min(i, sentences.length - 1));
    const id = ++session;
    synth.cancel();
    playing = true;
    updateUi();
    speakCurrent(id);
  }

  function speakCurrent(id) {
    if (id !== session) return;
    if (current >= sentences.length) {
      playing = false;
      current = 0;
      highlight(-1);
      els.bar.style.width = "100%";
      setStatus("Lecture terminée.");
      updateUi();
      return;
    }
    highlight(current);
    const u = new SpeechSynthesisUtterance(sentences[current].text);
    const v = selectedVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "fr-FR"; }
    u.rate = +els.rate.value;
    u.pitch = +els.pitch.value;
    u.onend = () => { if (id === session) { current++; speakCurrent(id); } };
    u.onerror = (e) => {
      if (id !== session || e.error === "interrupted" || e.error === "canceled") return;
      setStatus("Erreur de synthèse vocale : " + e.error);
      playing = false;
      updateUi();
    };
    setStatus(`Lecture… phrase ${current + 1} / ${sentences.length}`);
    // Petit délai : évite que Chrome ignore un énoncé lancé juste après cancel().
    setTimeout(() => { if (id === session) synth.speak(u); }, 30);
  }

  function pauseReading() {
    session++;
    synth.cancel();
    playing = false;
    setStatus(`En pause à la phrase ${current + 1} / ${sentences.length}.`);
    updateUi();
  }

  function stopReading() {
    session++;
    synth?.cancel();
    playing = false;
    current = 0;
    if (sentences.length) highlight(-1);
    els.bar.style.width = "0";
    updateUi();
  }

  els.play.addEventListener("click", () => speakFrom(current));
  els.pause.addEventListener("click", pauseReading);
  els.stop.addEventListener("click", () => { stopReading(); setStatus("Lecture arrêtée."); });
  els.prev.addEventListener("click", () => playing ? speakFrom(current - 1) : (current = Math.max(0, current - 1), highlight(current), updateUi()));
  els.next.addEventListener("click", () => playing ? speakFrom(current + 1) : (current = Math.min(sentences.length - 1, current + 1), highlight(current), updateUi()));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Space" && sentences.length) {
      e.preventDefault();
      playing ? pauseReading() : speakFrom(current);
    }
  });

  window.addEventListener("beforeunload", () => synth?.cancel());

  /* ---------- Chargement du fichier ---------- */

  async function handleFile(file) {
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStatus("Ce fichier n'est pas un PDF.");
      return;
    }
    if (!window.pdfjsLib) {
      setStatus("Impossible de charger le moteur PDF. Vérifiez votre connexion.");
      return;
    }
    els.fileName.textContent = file.name;
    closeEditor(false);
    try {
      const pages = await extractPdf(file);
      render(pages);
      if (sentences.length) setStatus(`${sentences.length} phrases prêtes. Cliquez sur « Lire ».`);
      else setStatus("Aucun texte trouvé dans ce PDF.");
    } catch (err) {
      console.error(err);
      setStatus(err?.name === "PasswordException"
        ? "Ce PDF est protégé par un mot de passe."
        : "Impossible de lire ce PDF.");
    }
  }

  els.file.addEventListener("change", () => handleFile(els.file.files[0]));
  ["dragenter", "dragover"].forEach((t) => els.drop.addEventListener(t, (e) => {
    e.preventDefault(); els.drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((t) => els.drop.addEventListener(t, (e) => {
    e.preventDefault(); els.drop.classList.remove("over");
  }));
  els.drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
  // Empêche le navigateur d'ouvrir le PDF si on le lâche à côté de la zone.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  /* ---------- Édition manuelle ---------- */

  function openEditor() {
    stopReading();
    els.editor.value = sentences.length
      ? [...els.reader.querySelectorAll("p")].map((p) => p.textContent.trim()).filter(Boolean).join("\n\n")
      : "";
    els.reader.hidden = true;
    els.editor.hidden = false;
    els.editToggle.textContent = "Valider le texte";
    els.editor.focus();
  }

  function closeEditor(apply) {
    if (els.editor.hidden) return;
    if (apply) {
      const paragraphs = els.editor.value
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      render([{ label: "", paragraphs }]);
      setStatus(sentences.length ? `${sentences.length} phrases prêtes.` : "");
    }
    els.editor.hidden = true;
    els.reader.hidden = false;
    els.editToggle.textContent = "Modifier / coller du texte";
  }

  els.editToggle.addEventListener("click", () => els.editor.hidden ? openEditor() : closeEditor(true));

  updateUi();
})();

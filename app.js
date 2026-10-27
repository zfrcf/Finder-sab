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

  /* ---------- Voix ---------- */

  // Voix neuronales Piper : générées dans le navigateur, gratuites, bien plus naturelles.
  const AI_VOICES = [
    { id: "fr_FR-siwis-medium", label: "Siwis — voix féminine naturelle" },
    { id: "fr_FR-tom-medium", label: "Tom — voix masculine naturelle" },
    { id: "fr_FR-upmc-medium", label: "UPMC — voix féminine posée" },
  ];
  const DEFAULT_VOICE = "ia:" + AI_VOICES[0].id;

  function loadVoices() {
    const saved = store.get("voix") || els.voice.value || DEFAULT_VOICE;
    els.voice.innerHTML = "";

    const aiGroup = document.createElement("optgroup");
    aiGroup.label = "Voix IA naturelles (recommandé)";
    for (const v of AI_VOICES) aiGroup.appendChild(new Option(v.label, "ia:" + v.id));
    els.voice.appendChild(aiGroup);

    const voices = synth ? synth.getVoices() : [];
    if (voices.length) {
      const sorted = [...voices].sort((a, b) => {
        const fa = a.lang.toLowerCase().startsWith("fr") ? 0 : 1;
        const fb = b.lang.toLowerCase().startsWith("fr") ? 0 : 1;
        return fa - fb || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
      });
      const webGroup = document.createElement("optgroup");
      webGroup.label = "Voix du navigateur (instantanées)";
      for (const v of sorted) webGroup.appendChild(new Option(`${v.name} (${v.lang})`, "web:" + v.voiceURI));
      els.voice.appendChild(webGroup);
    }

    const values = [...els.voice.options].map((o) => o.value);
    els.voice.value = values.includes(saved) ? saved : DEFAULT_VOICE;
    syncPitch();
  }

  const isAiVoice = () => els.voice.value.startsWith("ia:");
  const aiVoiceId = () => els.voice.value.slice(3);
  const selectedWebVoice = () => synth?.getVoices().find((v) => "web:" + v.voiceURI === els.voice.value);

  loadVoices();
  synth?.addEventListener?.("voiceschanged", loadVoices);

  // La tonalité n'est réglable qu'avec les voix du navigateur.
  function syncPitch() {
    const off = isAiVoice();
    els.pitch.disabled = off;
    els.pitch.closest("label").classList.toggle("off", off);
  }

  /* ---------- Moteur IA (Piper) ---------- */

  const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
  const PIPER_URL = "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js";

  const ai = {
    lib: null,
    tts: null,
    voiceId: null,
    loading: null,
    queue: Promise.resolve(),
    gen: 0,           // invalide les générations en attente quand le texte ou la voix change
    cache: new Map(), // index de phrase -> Promise<URL audio>
  };

  // Charge (ou change) la voix IA ; le modèle est mis en cache par le navigateur après le 1er téléchargement.
  function loadAiVoice(voiceId) {
    if (ai.tts && ai.voiceId === voiceId) return Promise.resolve(ai.tts);
    if (ai.loading && ai.voiceId === voiceId) return ai.loading;
    ai.voiceId = voiceId;
    ai.loading = (async () => {
      setStatus("Chargement de la voix IA…");
      ai.lib = ai.lib || await import(PIPER_URL);
      const { TtsSession } = ai.lib;
      // La session est un singleton : on la réinitialise pour changer de voix.
      TtsSession._instance = null;
      const tts = await TtsSession.create({
        voiceId,
        wasmPaths: { ...TtsSession.WASM_LOCATIONS, onnxWasm: ORT_DIST },
        progress: (p) => {
          if (p.total && p.url.endsWith(".onnx")) {
            setStatus(`Téléchargement de la voix IA… ${Math.round((p.loaded / p.total) * 100)} % (une seule fois)`);
          }
        },
      });
      if (ai.voiceId === voiceId) ai.tts = tts;
      return tts;
    })();
    ai.loading.catch(() => { if (ai.voiceId === voiceId) { ai.loading = null; ai.voiceId = null; } });
    return ai.loading;
  }

  // Génère l'audio d'une phrase ; les générations passent une par une dans une file.
  function synthesize(i) {
    if (ai.cache.has(i)) return ai.cache.get(i);
    const voiceId = aiVoiceId();
    const text = sentences[i].text;
    const gen = ai.gen;
    const job = ai.queue.then(async () => {
      if (gen !== ai.gen) throw new Error("annulé");
      const tts = await loadAiVoice(voiceId);
      const wav = await tts.predict(text);
      return URL.createObjectURL(wav);
    });
    ai.queue = job.catch(() => {});
    ai.cache.set(i, job);
    job.catch(() => ai.cache.delete(i));
    return job;
  }

  function clearAiCache() {
    for (const p of ai.cache.values()) p.then((url) => URL.revokeObjectURL(url), () => {});
    ai.cache.clear();
    ai.gen++;
  }

  const audio = new Audio();
  audio.preservesPitch = true;

  /* ---------- Réglages ---------- */

  function initRange(input, out, key, fmt) {
    const saved = store.get(key);
    if (saved) input.value = saved;
    const sync = () => { out.textContent = fmt(+input.value); store.set(key, input.value); };
    input.addEventListener("input", sync);
    input.addEventListener("change", () => { if (!isAiVoice()) restartIfPlaying(); });
    sync();
  }
  initRange(els.rate, els.rateOut, "vitesse", (v) => v.toFixed(1) + "×");
  initRange(els.pitch, els.pitchOut, "tonalite", (v) => v.toFixed(1));
  els.voice.addEventListener("change", () => {
    store.set("voix", els.voice.value);
    clearAiCache();
    syncPitch();
    restartIfPlaying();
  });
  // Avec la voix IA, la vitesse s'applique en direct sans relancer la phrase.
  els.rate.addEventListener("input", () => { audio.playbackRate = +els.rate.value; });

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
    clearAiCache();
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
    const has = sentences.length > 0;
    els.play.disabled = !has || playing;
    els.pause.disabled = !playing;
    els.stop.disabled = !has || (!playing && current === 0);
    els.prev.disabled = !has;
    els.next.disabled = !has;
    els.play.textContent = current > 0 && !playing ? "▶ Reprendre" : "▶ Lire";
  }

  /* ---------- Lecture ---------- */

  function speakFrom(i) {
    if (!sentences.length) return;
    current = Math.max(0, Math.min(i, sentences.length - 1));
    const id = ++session;
    synth?.cancel();
    audio.pause();
    playing = true;
    updateUi();
    speakCurrent(id);
  }

  function finished() {
    playing = false;
    current = 0;
    highlight(-1);
    els.bar.style.width = "100%";
    setStatus("Lecture terminée.");
    updateUi();
  }

  function failed(msg) {
    playing = false;
    setStatus(msg);
    updateUi();
  }

  function speakCurrent(id) {
    if (id !== session) return;
    if (current >= sentences.length) return finished();
    highlight(current);
    if (isAiVoice()) speakAi(id);
    else speakWeb(id);
  }

  async function speakAi(id) {
    const i = current;
    const pending = synthesize(i);
    // Prépare les deux phrases suivantes pendant la lecture de celle-ci.
    for (let k = i + 1; k <= i + 2 && k < sentences.length; k++) synthesize(k);
    let url;
    try {
      url = await pending;
    } catch (err) {
      if (id !== session) return;
      console.error(err);
      return failed("Impossible de charger la voix IA. Vérifiez votre connexion ou choisissez une voix du navigateur.");
    }
    if (id !== session) return;
    setStatus(`Lecture… phrase ${i + 1} / ${sentences.length}`);
    audio.src = url;
    audio.playbackRate = +els.rate.value;
    audio.onended = () => { if (id === session) { current++; speakCurrent(id); } };
    audio.onerror = () => { if (id === session) failed("Erreur de lecture audio."); };
    try {
      await audio.play();
    } catch (err) {
      if (id === session && err.name !== "AbortError") failed("Lecture bloquée par le navigateur : cliquez sur « Lire ».");
    }
  }

  function speakWeb(id) {
    if (!synth) return failed("Votre navigateur ne prend pas en charge la synthèse vocale. Choisissez une voix IA.");
    const u = new SpeechSynthesisUtterance(sentences[current].text);
    const v = selectedWebVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "fr-FR"; }
    u.rate = +els.rate.value;
    u.pitch = +els.pitch.value;
    u.onend = () => { if (id === session) { current++; speakCurrent(id); } };
    u.onerror = (e) => {
      if (id !== session || e.error === "interrupted" || e.error === "canceled") return;
      failed("Erreur de synthèse vocale : " + e.error);
    };
    setStatus(`Lecture… phrase ${current + 1} / ${sentences.length}`);
    // Petit délai : évite que Chrome ignore un énoncé lancé juste après cancel().
    setTimeout(() => { if (id === session) synth.speak(u); }, 30);
  }

  function pauseReading() {
    session++;
    synth?.cancel();
    audio.pause();
    playing = false;
    setStatus(`En pause à la phrase ${current + 1} / ${sentences.length}.`);
    updateUi();
  }

  function stopReading() {
    session++;
    synth?.cancel();
    audio.pause();
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
      if (sentences.length) {
        setStatus(`${sentences.length} phrases prêtes. Cliquez sur « Lire ».`);
        // Prépare la voix IA et la 1re phrase en avance pour un démarrage immédiat.
        if (isAiVoice()) synthesize(0).then(() => { if (!playing) setStatus(`${sentences.length} phrases prêtes. Cliquez sur « Lire ».`); }, () => {});
      }
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

import { createSignal, For, Show, onSettled } from 'solid-js';
import QRCode from 'qrcode';

type Peer = { id: string; name: string; approved: boolean; volume: number; muted: boolean; state: string; level: number; receiving: boolean; packets: number; trackState: string };
type Connection = { pc: RTCPeerConnection; gain?: GainNode; source?: MediaElementAudioSourceNode; element?: HTMLAudioElement; analyser?: AnalyserNode; pending: RTCIceCandidateInit[]; signalQueue: Promise<void>; meter?: number; statsTimer?: number };

export default function Karaoke() {
  const params = new URLSearchParams(location.search);
  const isPhone = !!params.get('room');
  const [status, setStatus] = createSignal('Ready');
  const [room, setRoom] = createSignal('');
  const [name, setName] = createSignal('');
  const [peers, setPeers] = createSignal<Peer[]>([]);
  const [addresses, setAddresses] = createSignal<string[]>([]);
  const [address, setAddress] = createSignal(location.hostname);
  const [qr, setQr] = createSignal('');
  const [lyrics, setLyrics] = createSignal('');
  const [joined, setJoined] = createSignal(false);
  const [localMuted, setLocalMuted] = createSignal(false);
  const [audioState, setAudioState] = createSignal('not started');
  const [phoneLevel, setPhoneLevel] = createSignal(0);
  const [phoneTrackState, setPhoneTrackState] = createSignal('not started');
  const [phoneMeterState, setPhoneMeterState] = createSignal('not started');
  let socket: WebSocket | undefined;
  let stream: MediaStream | undefined;
  let audio: AudioContext | undefined;
  let projector: Window | null = null;
  let phoneMeter: number | undefined;
  const connections = new Map<string, Connection>();
  const update = (id: string, patch: Partial<Peer>) => setPeers(old => old.map(p => p.id === id ? { ...p, ...patch } : p));
  const send = (data: object) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
  const link = () => `${location.protocol}//${address()}:${location.port || (location.protocol === 'https:' ? '443' : '80')}/?room=${room()}`;
  async function refreshQr(code: string, host: string) { setQr(await QRCode.toDataURL(`${location.protocol}//${host}:${location.port || (location.protocol === 'https:' ? '443' : '80')}/?room=${code}`, { width: 220, margin: 1 })); }
  function closePeer(id: string) { const c = connections.get(id); if (c?.meter) clearInterval(c.meter); if (c?.statsTimer) clearInterval(c.statsTimer); c?.pc.close(); c?.source?.disconnect(); c?.analyser?.disconnect(); c?.gain?.disconnect(); if (c?.element) { c.element.pause(); c.element.srcObject = null; } connections.delete(id); }
  function stopPhoneMeter() { if (phoneMeter) clearInterval(phoneMeter); phoneMeter = undefined; }
  function cleanup() { stopPhoneMeter(); socket?.close(); for (const id of connections.keys()) closePeer(id); stream?.getTracks().forEach(t => t.stop()); void audio?.close(); }
  function connection(id: string) {
    let c = connections.get(id); if (c) return c;
    const pc = new RTCPeerConnection({ iceServers: [] });
    c = { pc, pending: [], signalQueue: Promise.resolve() }; connections.set(id, c);
    pc.onicecandidate = e => { if (e.candidate) send({ type: 'signal', id, data: { candidate: e.candidate.toJSON() } }); };
    pc.onconnectionstatechange = () => { if (!isPhone) update(id, { state: pc.connectionState }); else setStatus(`Microphone ${pc.connectionState}`); };
    pc.ontrack = e => {
      if (!audio || e.track.kind !== 'audio') return;
      // A browser may ignore this hint; low buffering can trade smoothness for delay.
      const receiver = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number };
      if ('jitterBufferTarget' in receiver) { try { receiver.jitterBufferTarget = 0; } catch { /* unsupported */ } }
      const current = connections.get(id); if (!current) return;
      if (current.meter) clearInterval(current.meter);
      if (current.statsTimer) clearInterval(current.statsTimer);
      current.source?.disconnect(); current.analyser?.disconnect(); current.gain?.disconnect();
      if (current.element) { current.element.pause(); current.element.srcObject = null; }
      const gain = audio.createGain();
      const element = new Audio(); element.autoplay = true; element.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      const source = audio.createMediaElementSource(element);
      const analyser = audio.createAnalyser(); analyser.fftSize = 512;
      source.connect(analyser); analyser.connect(gain).connect(audio.destination);
      const peer = peers().find(p => p.id === id); gain.gain.value = peer?.muted ? 0 : (peer?.volume ?? 100) / 100;
      current.gain = gain; current.source = source; current.analyser = analyser; current.element = element;
      void element.play().catch(() => setStatus('Audio playback blocked. Click Test speakers to enable sound.'));
      const trackState = () => update(id, { receiving: true, trackState: e.track.readyState === 'ended' ? 'ended' : e.track.muted ? 'muted by source' : 'live' });
      trackState(); e.track.onmute = trackState; e.track.onunmute = trackState;
      let previousEnergy = 0; let previousDuration = 0;
      current.statsTimer = window.setInterval(() => {
        void pc.getStats().then(stats => {
          let packets = 0; let level = 0;
          stats.forEach(report => {
            if (report.type !== 'inbound-rtp' || report.kind !== 'audio') return;
            packets += report.packetsReceived || 0;
            const energy = report.totalAudioEnergy; const duration = report.totalSamplesDuration;
            if (typeof energy === 'number' && typeof duration === 'number' && duration > previousDuration) {
              level = Math.sqrt(Math.max(0, energy - previousEnergy) / (duration - previousDuration));
              previousEnergy = energy; previousDuration = duration;
            } else if (typeof report.audioLevel === 'number') level = report.audioLevel;
          });
          update(id, { packets, level: Math.min(100, Math.round(level * 500)) });
        }).catch(() => {});
      }, 250);
      e.track.onended = () => update(id, { receiving: false, level: 0, trackState: 'ended' });
    };
    return c;
  }
  async function handleSignal(id: string, data: any) {
    const c = connection(id);
    if (data.description) {
      await c.pc.setRemoteDescription(data.description);
      for (const candidate of c.pending.splice(0)) await c.pc.addIceCandidate(candidate);
      if (data.description.type === 'offer') { await c.pc.setLocalDescription(await c.pc.createAnswer()); send({ type: 'signal', id, data: { description: c.pc.localDescription } }); }
    } else if (data.candidate) { if (c.pc.remoteDescription) await c.pc.addIceCandidate(data.candidate); else c.pending.push(data.candidate); }
  }
  function connect(role: 'create' | 'join') {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`);
    socket.onopen = () => send(role === 'create' ? { type: 'create' } : { type: 'join', room: params.get('room'), name: name() });
    socket.onmessage = async e => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'created') { setRoom(m.room); setStatus('Room live'); await refreshQr(m.room, address()); }
        if (m.type === 'waiting') setStatus('Waiting for host approval');
        if (m.type === 'peer-joined') setPeers(old => [...old, { id: m.id, name: m.name, approved: false, volume: 100, muted: false, state: 'waiting', level: 0, receiving: false, packets: 0, trackState: 'waiting' }]);
        if (m.type === 'peer-approved') update(m.id, { approved: true, state: 'connecting' });
        if (m.type === 'approved' && stream) {
          setStatus('Approved · connecting'); const c = connection('host');
          stream.getTracks().forEach(t => c.pc.addTrack(t, stream!));
          await c.pc.setLocalDescription(await c.pc.createOffer()); send({ type: 'signal', data: { description: c.pc.localDescription } });
        }
        if (m.type === 'signal') {
          const id = m.id || 'host'; const c = connection(id);
          c.signalQueue = c.signalQueue.then(() => handleSignal(id, m.data)).catch(err => { setStatus(`Connection error: ${err instanceof Error ? err.message : 'unknown error'}`); });
        }
        if (m.type === 'peer-left') { closePeer(m.id); setPeers(old => old.filter(p => p.id !== m.id)); }
        if (m.type === 'room-closed' || m.type === 'removed') { setStatus(m.type === 'removed' ? 'Removed by host' : 'Room closed'); stream?.getTracks().forEach(t => t.stop()); }
        if (m.type === 'error') { setStatus(m.message); stream?.getTracks().forEach(t => t.stop()); }
      } catch (err) { setStatus(`Connection error: ${err instanceof Error ? err.message : 'unknown error'}`); }
    };
    socket.onerror = () => setStatus('Could not connect to server');
    socket.onclose = () => { setStatus('Disconnected. Reload to reconnect.'); stopPhoneMeter(); for (const id of connections.keys()) closePeer(id); stream?.getTracks().forEach(t => t.stop()); setPhoneTrackState('ended'); };
  }
  async function startHost() { try { audio = new AudioContext({ latencyHint: 'interactive' }); audio.onstatechange = () => setAudioState(audio?.state || 'closed'); await audio.resume(); setAudioState(audio.state); connect('create'); setJoined(true); } catch (e) { setStatus(`Audio unavailable: ${e}`); } }
  async function testSpeakers() {
    if (!audio) return;
    try {
      await audio.resume(); setAudioState(audio.state);
      for (const c of connections.values()) if (c.element) void c.element.play().catch(() => setStatus('Audio playback is blocked by the browser.'));
      const oscillator = audio.createOscillator(); const gain = audio.createGain();
      oscillator.frequency.value = 440; gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
      oscillator.connect(gain).connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.3);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    } catch (e) { setStatus(`Speaker test failed: ${e instanceof Error ? e.message : e}`); }
  }
  async function join() {
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('Microphone unavailable. Open this page over trusted HTTPS.'); return; }
    try {
      // Construct the meter context during the tap so mobile autoplay rules allow it to run.
      audio = new AudioContext({ latencyHint: 'interactive' });
      void audio.resume().then(() => setPhoneMeterState(audio?.state || 'closed')).catch(() => setPhoneMeterState('unavailable'));
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      const track = stream.getAudioTracks()[0];
      const updateTrack = () => setPhoneTrackState(track.readyState === 'ended' ? 'ended' : !track.enabled ? 'muted by you' : track.muted ? 'muted by phone' : 'live');
      track.onmute = updateTrack; track.onunmute = updateTrack; track.onended = updateTrack; updateTrack();
      const source = audio.createMediaStreamSource(stream); const analyser = audio.createAnalyser(); const silence = audio.createGain();
      analyser.fftSize = 512; silence.gain.value = 0; source.connect(analyser).connect(silence).connect(audio.destination);
      const samples = new Float32Array(analyser.fftSize);
      phoneMeter = window.setInterval(() => { analyser.getFloatTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); setPhoneLevel(Math.min(100, Math.round(rms * 500))); updateTrack(); }, 200);
      connect('join'); setJoined(true);
    } catch (e) { stream?.getTracks().forEach(t => t.stop()); void audio?.close(); audio = undefined; setStatus(`Microphone access failed: ${e instanceof Error ? e.message : e}`); }
  }
  function setMixer(p: Peer, volume: number, muted: boolean) { update(p.id, { volume, muted }); const gain = connections.get(p.id)?.gain; if (gain) gain.gain.value = muted ? 0 : volume / 100; }
  function showLyrics() { projector = window.open('', 'roomtone-lyrics'); if (!projector) { setStatus('Allow pop-ups to open the lyrics display'); return; } projector.document.title = 'Karaoke lyrics'; projector.document.body.style.cssText = 'background:#111;color:white;font: bold 5vw system-ui;white-space:pre-wrap;text-align:center;padding:5vh'; projector.document.body.textContent = lyrics(); }
  onSettled(() => { if (!isPhone) fetch('/api/network').then(r => r.json()).then(data => { setAddresses(data.addresses); if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') setAddress(data.addresses[0] || location.hostname); }).catch(() => {}); return cleanup; });
  return <main><header><div class="brand"><span class="brand-icon">?</span> ROOMTONE <span class="tag">KARAOKE</span></div><span class="status"><i />{status()}</span></header>
    <Show when={!isPhone} fallback={<section class="phone"><div class="eyebrow">YOUR PHONE IS THE MIC</div><h1>Take the <em>stage.</em></h1><p>Join the room, allow microphone access, and wait for the host to approve you.</p><Show when={!joined()} fallback={<><div class="live-card"><span class="mic-icon">?</span><h2>{status()}</h2><p>Keep this page open while singing.</p><div class="input-level"><span>Phone mic</span><meter min="0" max="100" value={phoneLevel()} aria-label="Phone microphone input" /></div><p class="footnote">Mic: {phoneTrackState()} / meter: {phoneMeterState()}</p></div><button class="primary wide" onClick={() => { const next = !localMuted(); stream?.getAudioTracks().forEach(t => t.enabled = !next); setLocalMuted(next); }}>{localMuted() ? 'Unmute microphone' : 'Mute microphone'}</button></>}><label>Your name<input maxlength="32" placeholder="e.g. Alex" value={name()} onInput={e => setName(e.currentTarget.value)} /></label><button class="primary wide" onClick={join}>Join with microphone <span>?</span></button></Show><p class="footnote">Use headphones or keep your phone away from the speakers to avoid feedback.</p></section>}>
      <section class="hero"><div><div class="eyebrow">YOUR LIVING ROOM, LIVE</div><h1>Everyone gets<br /><em>a microphone.</em></h1><p>Turn phones into wireless microphones. Mix the voices, cue the lyrics, and let the good times roll.</p><Show when={!joined()}><button class="primary" onClick={startHost}>Start a session <span>?</span></button></Show></div><div class="hero-art"><span>?</span><div>GOOD<br />TIMES<br /><em>ONLY.</em></div><small>THE STAGE IS YOURS / 01</small></div></section>
      <Show when={joined()}><div class="dashboard"><section class="panel"><div class="section-head"><div><div class="eyebrow">01 / INVITE THE CREW</div><h2>Join the session</h2></div><span class="pill">LOCAL NETWORK</span></div><p>Connect phones to the same Wi-Fi, then scan this code.</p><div class="invite"><Show when={qr()}><img src={qr()} alt="QR code to join the room" /></Show><div><label>Network address<select value={address()} onChange={e => { setAddress(e.currentTarget.value); void refreshQr(room(), e.currentTarget.value); }}><For each={addresses().length ? addresses() : [address()]}>{a => <option value={a}>{a}</option>}</For></select></label><a class="link" href={link()}>{link()}</a><p class="footnote">Phones need to trust this HTTPS certificate before joining.</p></div></div></section>
      <section class="panel"><div class="section-head"><div><div class="eyebrow">02 / SOUND CHECK</div><h2>Microphone mixer</h2></div><span class="pill">{peers().length} CONNECTED</span></div><div class="sound-check"><button onClick={testSpeakers}>Test speakers</button><span>Audio output: {audioState()}</span></div><Show when={peers().length} fallback={<div class="empty">?<p>No microphones yet.<br />Share the QR code to get started.</p></div>}><For each={peers()} keyed={false}>{p => <div class="peer"><div class="peer-top"><strong>{p().name}</strong><span>{p().state}</span><Show when={!p().approved}><button onClick={() => send({ type: 'approve', id: p().id })}>Approve</button></Show><button class="quiet" onClick={() => send({ type: 'remove', id: p().id })}>Remove</button></div><Show when={p().approved}><div class="controls"><button onClick={() => setMixer(p(), p().volume, !p().muted)}>{p().muted ? 'Unmute' : 'Mute'}</button><input aria-label={`Volume for ${p().name}`} type="range" min="0" max="150" value={p().volume} onInput={e => setMixer(p(), Number(e.currentTarget.value), p().muted)} /><span>{p().volume}%</span></div><div class="input-level"><span>{p().receiving ? 'Mic input' : 'Waiting for audio track'}</span><meter min="0" max="100" value={p().level} aria-label={`Microphone input for ${p().name}`} /></div><p class="footnote">Track: {p().trackState} / Audio packets received: {p().packets}</p></Show></div>}</For></Show></section>
      <section class="panel lyrics"><div class="section-head"><div><div class="eyebrow">03 / SING ALONG</div><h2>Lyrics display</h2></div><button onClick={showLyrics}>Open projector view ?</button></div><p>Paste your lyrics below. The projector view updates as you type.</p><textarea placeholder="Paste lyrics here..." value={lyrics()} onInput={e => { setLyrics(e.currentTarget.value); if (projector && !projector.closed) projector.document.body.textContent = e.currentTarget.value; }} /></section></div></Show>
      <footer>MADE FOR GOOD NIGHTS <span>?</span> RUNS ON YOUR LOCAL NETWORK</footer></Show></main>;
}


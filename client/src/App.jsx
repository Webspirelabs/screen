import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  ArrowRight, Check, ChevronDown, CircleHelp, Eye, EyeOff, Headphones,
  LockKeyhole, Monitor, ShieldCheck, Sparkles, X
} from 'lucide-react';

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
};

function Header({ admin = false }) {
  return <header className="topbar">
    <a className="brand" href={admin ? '/admin/login' : '/'}><span className="brand-icon"><Monitor size={18} /></span> clearview</a>
    {admin ? <a className="nav-link" href="/">Back to website <ArrowRight size={15} /></a> : <nav>
      <a href="#how">How it works</a><a href="#services">Services</a><a href="#contact">Contact</a>
      <a className="nav-admin" href="/admin/login">Admin <ArrowRight size={15} /></a>
    </nav>}
  </header>;
}

function ShareControl() {
  const [state, setState] = useState('idle');
  const [message, setMessage] = useState('');
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const peerRef = useRef(null);
  const sessionRef = useRef(null);
  const pendingSignalsRef = useRef([]);
  const pendingCandidatesRef = useRef([]);

  const handleSignal = async (signal, socket) => {
    if (signal.sessionId !== sessionRef.current) return;
    const peer = peerRef.current;
    if (!peer) {
      pendingSignalsRef.current.push(signal);
      return;
    }
    if (signal.description) {
      await peer.setRemoteDescription(signal.description);
      for (const candidate of pendingCandidatesRef.current.splice(0)) {
        await peer.addIceCandidate(candidate);
      }
      if (signal.description.type === 'offer') {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('rtc:signal', { sessionId: sessionRef.current, description: peer.localDescription });
      }
    } else if (signal.candidate) {
      if (!peer.remoteDescription) pendingCandidatesRef.current.push(signal.candidate);
      else await peer.addIceCandidate(signal.candidate);
    }
  };

  const stop = (reason = 'user') => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    peerRef.current?.close();
    pendingSignalsRef.current = [];
    pendingCandidatesRef.current = [];
    if (sessionRef.current) socketRef.current?.emit('share:stop', { sessionId: sessionRef.current, reason });
    socketRef.current?.disconnect();
    socketRef.current = null;
    streamRef.current = null;
    peerRef.current = null;
    sessionRef.current = null;
    setState('idle');
  };

  const start = async () => {
    if (!window.isSecureContext && window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1') {
      setMessage('Screen sharing requires a secure HTTPS connection. Open this site using HTTPS, then try again.');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setMessage('This browser does not support screen capture. Try a supported desktop browser, or use an HTTPS connection on mobile.');
      return;
    }
    setMessage('');
    setState('requesting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (error) {
      setState('idle');
      setMessage(error.name === 'NotAllowedError'
        ? 'Screen sharing was not allowed. Nothing was captured or sent.'
        : 'Could not start screen sharing. Please try again.');
      return;
    }
    streamRef.current = stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setState('idle');
      setMessage('No screen was selected. Please try again.');
      return;
    }

    const socket = io({ withCredentials: true, auth: { role: 'sharer' } });
    socketRef.current = socket;
    socket.on('rtc:signal', (signal) => {
      handleSignal(signal, socket).catch(() => {
        setMessage('The screen connection could not be negotiated. Stop sharing and try again.');
      });
    });
    socket.on('connect', () => {
      socket.emit('share:start', (result) => {
        if (result?.error) {
          setMessage(result.error);
          stop();
          return;
        }
        sessionRef.current = result.sessionId;
        setState('sharing');
      });
    });
    socket.on('connect_error', (error) => {
      const status = error.description?.status;
      const reason = status ? `${error.message}, HTTP ${status}` : error.message;
      setMessage(`Unable to connect to the sharing service (${reason}). Check that the backend is running and open the site from its allowed address.`);
      stop();
    });
    socket.on('disconnect', () => stop('disconnected'));
    socket.on('viewer:ready', async ({ sessionId }) => {
      if (sessionId !== sessionRef.current || !streamRef.current) return;
      try {
        const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        peerRef.current = peer;
        streamRef.current.getTracks().forEach((track) => peer.addTrack(track, streamRef.current));
        peer.onicecandidate = (event) => {
          if (event.candidate) socket.emit('rtc:signal', { sessionId, candidate: event.candidate });
        };
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === 'failed') setMessage('The viewer connection failed. Sharing remains under your control.');
        };
        for (const signal of pendingSignalsRef.current.splice(0)) {
          await handleSignal(signal, socket);
        }
      } catch {
        setMessage('Unable to establish the screen-sharing connection. Stop sharing and try again.');
      }
    });
    socket.on('session:ended', () => stop());
    videoTrack.addEventListener('ended', () => stop('permission_revoked'), { once: true });
  };

  return <div className={`share-panel ${state === 'sharing' ? 'is-sharing' : ''}`}>
    <div className="share-panel-top"><span className="share-icon"><Monitor size={20} /></span><span className={`status-pill ${state === 'sharing' ? 'active' : ''}`}><i />{state === 'sharing' ? 'Sharing active' : 'Not sharing'}</span></div>
    <h3>{state === 'sharing' ? 'Your screen is being shared' : 'Start a secure sharing session'}</h3>
    <p>{state === 'sharing'
      ? 'An authorized support administrator can now view the screen you selected. You can stop sharing at any time.'
      : 'Choose what to share in your browser’s permission dialog. You remain in control throughout the session.'}</p>
    {state !== 'sharing' ? <button className="button button-dark full" onClick={start} disabled={state === 'requesting'}>
      {state === 'requesting' ? 'Waiting for browser permission…' : 'Choose a screen to share'} <ArrowRight size={16} />
    </button> : <button className="button button-stop full" onClick={() => stop()}>Stop sharing <X size={16} /></button>}
    {message && <div className="inline-message" role="status">{message}</div>}
    <div className="privacy-note"><LockKeyhole size={15} /> Nothing is captured or transmitted without browser permission.</div>
  </div>;
}

function Landing() {
  return <><Header /><main>
    <section className="hero">
      <div className="hero-copy"><div className="eyebrow"><span className="eyebrow-dot" /> REMOTE HELP, MADE HUMAN</div>
        <h1>Better support.<br /><em>On your terms.</em></h1>
        <p className="hero-lead">Get the help you need with secure, real-time screen sharing. You choose what to share — and when to stop.</p>
        <a href="#share" className="button button-dark">Get started <ArrowRight size={17} /></a>
        <div className="hero-proof"><ShieldCheck size={18} /><span><b>Private by design</b><br />Your permission is always required</span></div>
      </div>
      <div className="hero-visual">
        <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" />
        <div className="screen-card"><div className="screen-head"><span className="window-dots"><i /><i /><i /></span><span>Secure support session</span><LockKeyhole size={14} /></div>
          <div className="screen-content"><div className="mini-sidebar"><div /><div /><div /><div /></div><div className="mini-main"><span className="mini-label">YOUR SESSION</span><div className="mini-title">Ready when you are.</div><div className="mini-line line-long" /><div className="mini-line line-short" /><div className="mini-action"><Monitor size={14} /> Share a screen</div></div></div>
        </div>
        <div className="floating-badge"><span><ShieldCheck size={19} /></span><div><b>Always in control</b><small>Stop sharing anytime</small></div><Check size={17} /></div>
        <div className="visual-stamp"><Sparkles size={16} /> BUILT AROUND YOU</div>
      </div>
    </section>
    <section className="trust-strip"><span>SUPPORT THAT RESPECTS YOUR PRIVACY</span><div><ShieldCheck size={18} /> Your choice</div><div><LockKeyhole size={18} /> Encrypted connection</div><div><EyeOff size={18} /> No hidden capture</div></section>
    <section className="how-section" id="how"><div className="section-intro"><div className="eyebrow">SIMPLE BY DESIGN</div><h2>Help is just a few<br /><em>clicks away.</em></h2><p>No downloads, no surprises. Just a secure connection when you need one.</p></div>
      <div className="steps"><article><span className="step-num">01</span><div className="step-icon"><Headphones /></div><h3>Connect with support</h3><p>Reach out to an authorized support administrator for a guided session.</p></article><article><span className="step-num">02</span><div className="step-icon"><Monitor /></div><h3>You choose to share</h3><p>Select a screen or window in your browser’s own permission prompt.</p></article><article><span className="step-num">03</span><div className="step-icon"><Eye /></div><h3>Stay in control</h3><p>See when sharing is active and stop it instantly whenever you like.</p></article></div>
    </section>
    <section className="service-section" id="services"><div className="service-copy"><div className="eyebrow">HERE WHEN YOU NEED US</div><h2>Real help.<br /><em>Real people.</em></h2><p>Whether you’re troubleshooting a technical issue or need a hand getting set up, screen sharing helps us understand what you’re seeing — without taking control away from you.</p><a className="text-link" href="#contact">Explore our approach <ArrowRight size={16} /></a></div>
      <div className="service-card"><div className="service-card-icon"><CircleHelp size={22} /></div><h3>Support, not surveillance.</h3><p>We can only see the content you deliberately share through your browser. We never access your device in the background.</p><div className="service-separator" /><div className="service-assurance"><ShieldCheck size={19} /> Your consent comes first</div></div>
    </section>
    <section className="share-section" id="share"><div className="share-heading"><div className="eyebrow">READY WHEN YOU ARE</div><h2>Share only when<br /><em>you say so.</em></h2><p>Starting a session opens your browser’s screen picker. Nothing is shared until you select a screen and confirm.</p><div className="share-check"><Check size={16} /> You can stop at any moment</div></div><ShareControl /></section>
    <section className="faq-section" id="contact"><div><div className="eyebrow">GOOD TO KNOW</div><h2>Your privacy<br /><em>matters.</em></h2></div><div className="faq-list"><details><summary>What can the support person see? <ChevronDown size={17} /></summary><p>Only the screen, window, or browser tab you choose in the browser’s native sharing prompt. The browser displays a sharing indicator while permission is active.</p></details><details><summary>Can I stop sharing at any time? <ChevronDown size={17} /></summary><p>Yes. Use the Stop sharing button here, or stop sharing using your browser’s own screen-sharing controls. The video stream ends immediately.</p></details><details><summary>Do I need to install anything? <ChevronDown size={17} /></summary><p>No installation is needed. Screen sharing uses the standard browser permission prompt in a supported, up-to-date browser.</p></details></div></section>
  </main><footer><a className="brand" href="/"><span className="brand-icon"><Monitor size={18} /></span> clearview</a><span>Thoughtful support, with your permission.</span><span>© 2026 Clearview Support</span></footer></>;
}

function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    api('/api/auth/me').then(() => { window.location.href = '/admin'; }).catch(() => setChecked(true));
  }, []);
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      window.location.href = '/admin';
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };
  return <><Header admin /><main className="login-page"><div className="login-aside"><div className="eyebrow"><span className="eyebrow-dot" /> ADMINISTRATOR ACCESS</div><h1>A clear view.<br /><em>A safer way to help.</em></h1><p>Sign in to manage active, user-authorized support sessions. Screen sharing is available only while a user has explicitly enabled it.</p><div className="login-promise"><ShieldCheck /> Consent-first viewing <span>•</span> Secure sign-in</div></div>
    <div className="login-card"><div className="login-mark"><LockKeyhole size={20} /></div><div className="eyebrow">WELCOME BACK</div><h2>Admin sign in</h2><p>Use your administrator credentials to continue.</p>
      {checked && <form onSubmit={submit}><label htmlFor="username">Username</label><input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <label htmlFor="password">Password</label><div className="password-wrap"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><button className="show-password" type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
        {error && <div className="form-error" role="alert">{error}</div>}<button className="button button-dark full login-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'} <ArrowRight size={16} /></button></form>}
      <div className="login-foot"><LockKeyhole size={14} /> Protected administrator area</div></div>
    </main><footer><a className="brand" href="/"><span className="brand-icon"><Monitor size={18} /></span> clearview</a><span>Authorized access only</span><span>© 2026 Clearview Support</span></footer></>;
}

function AdminDashboard() {
  const [user, setUser] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeId, setActiveId] = useState(null);
  const activeIdRef = useRef(null);
  const videoRef = useRef(null);
  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  const closeViewer = (sessionId = activeId) => {
    if (sessionId) socketRef.current?.emit('viewer:leave', { sessionId });
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidatesRef.current = [];
    if (videoRef.current) videoRef.current.srcObject = null;
    activeIdRef.current = null;
    setActiveId(null);
  };

  useEffect(() => {
    let alive = true;
    api('/api/auth/me').then((data) => {
      if (!alive) return;
      setUser(data.user);
      return api('/api/sessions');
    }).then((data) => {
      if (!alive || !data) return;
      setSessions(data.sessions);
      const socket = io({ withCredentials: true, auth: { role: 'admin' } });
      socketRef.current = socket;
      socket.on('session:updated', (session) => setSessions((old) => [session, ...old.filter((s) => s.id !== session.id)]));
      socket.on('session:ended', ({ sessionId, reason }) => {
        setNotice(reason === 'administrator' ? 'You ended the viewing session.' : 'The user stopped sharing or disconnected.');
        if (activeIdRef.current === sessionId) closeViewer(sessionId);
      });
      socket.on('rtc:signal', async ({ sessionId, description, candidate }) => {
        if (sessionId !== activeIdRef.current || !peerRef.current) return;
        try {
          if (description) {
            await peerRef.current.setRemoteDescription(description);
            for (const candidate of pendingCandidatesRef.current.splice(0)) {
              await peerRef.current.addIceCandidate(candidate);
            }
            if (description.type === 'offer') {
              const answer = await peerRef.current.createAnswer();
              await peerRef.current.setLocalDescription(answer);
              socket.emit('rtc:signal', { sessionId, description: peerRef.current.localDescription });
            }
          } else if (candidate) {
            if (!peerRef.current.remoteDescription) pendingCandidatesRef.current.push(candidate);
            else await peerRef.current.addIceCandidate(candidate);
          }
        } catch { setError('WebRTC negotiation failed. Close the viewer and try again.'); }
      });
    }).catch((err) => {
      if (alive) window.location.href = '/admin/login';
      setError(err.message);
    });
    return () => { alive = false; socketRef.current?.disconnect(); peerRef.current?.close(); };
  }, []);

  const viewSession = (session) => {
    setError('');
    setNotice('');
    if (activeIdRef.current) closeViewer(activeIdRef.current);
    pendingCandidatesRef.current = [];
    activeIdRef.current = session.id;
    setActiveId(session.id);
    const socket = socketRef.current;
    if (!socket?.connected) {
      setError('Connecting to the signaling service. Please try again shortly.');
      activeIdRef.current = null;
      setActiveId(null);
      return;
    }
    let peer;
    try {
      peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      peerRef.current = peer;
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.ontrack = (event) => { if (videoRef.current) videoRef.current.srcObject = event.streams[0]; };
      peer.onicecandidate = (event) => {
        if (event.candidate) socket.emit('rtc:signal', { sessionId: session.id, candidate: event.candidate });
      };
    } catch {
      setError('Unable to initialize the video viewer.');
      closeViewer(session.id);
      return;
    }
    socket.emit('viewer:join', { sessionId: session.id }, async (result) => {
      if (result?.error) { setError(result.error); closeViewer(session.id); return; }
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('rtc:signal', { sessionId: session.id, description: peer.localDescription });
      } catch { setError('Unable to initialize the video viewer.'); closeViewer(session.id); }
    });
  };

  const endSession = async (id) => {
    try { await api(`/api/sessions/${id}/end`, { method: 'POST' }); setNotice('Sharing ended. The user’s screen stream has been stopped.'); }
    catch (err) { setError(err.message); }
  };
  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); window.location.href = '/admin/login'; }
    catch (err) { setError(`Unable to sign out: ${err.message}`); }
  };
  const activeSessions = sessions.filter((session) => session.status === 'active');
  if (!user) return <div className="loading-screen"><div className="brand-icon"><Monitor size={18} /></div><span>Loading secure dashboard…</span></div>;
  return <div className="dashboard"><header className="dashboard-header"><a className="brand" href="/"><span className="brand-icon"><Monitor size={18} /></span> clearview</a><div className="dashboard-right"><span className="admin-identity"><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><span>{user.username}<small>Administrator</small></span></span><button className="logout-button" onClick={logout}>Sign out</button></div></header>
    <main className="dashboard-main"><div className="dashboard-title"><div><div className="eyebrow">SECURE SUPPORT CONSOLE</div><h1>Session overview</h1><p>Only sessions actively started with the user’s browser permission are listed here.</p></div><span className="live-tag"><i /> LIVE</span></div>
      {error && <div className="dashboard-alert error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
      {notice && <div className="dashboard-alert" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}
      <div className="stats-row"><div className="stat-card"><span>ACTIVE SHARES</span><b>{activeSessions.length}</b><small>Currently available to view</small></div><div className="stat-card"><span>ALL SESSIONS</span><b>{sessions.length}</b><small>Recent session activity</small></div><div className="stat-card privacy-stat"><ShieldCheck size={21} /><div><b>Consent required</b><small>Users initiate every screen share</small></div></div></div>
      <section className="sessions-section"><div className="list-heading"><div><h2>Screen-sharing sessions</h2><p>Connect only when a user’s session is active.</p></div><span className="count-badge">{activeSessions.length} active</span></div>
        {sessions.length === 0 ? <div className="empty-state"><div><Monitor size={22} /></div><h3>No sharing sessions yet</h3><p>When someone chooses to share their screen, their session will appear here.</p></div> : <div className="session-list">{sessions.map((session) => <article className="session-row" key={session.id}><div className={`session-icon ${session.status}`}><Monitor size={19} /></div><div className="session-meta"><strong>{session.status === 'active' ? 'Authorized screen share' : 'Screen-sharing session'}</strong><span>Started {new Date(session.startedAt).toLocaleString()}</span></div><span className={`session-status ${session.status}`}><i />{session.status === 'active' ? 'Available' : `Ended${session.endReason ? ` · ${session.endReason.replaceAll('_', ' ')}` : ''}`}</span><div className="session-actions">{session.status === 'active' && <><button className="button button-view" onClick={() => viewSession(session)} disabled={activeId === session.id}>{activeId === session.id ? 'Viewing' : 'View screen'} <Eye size={15} /></button><button className="end-link" onClick={() => endSession(session.id)}>End session</button></>}</div></article>)}</div>}
      </section>
      {activeId && <section className="viewer-section"><div className="viewer-heading"><div><div className="eyebrow">LIVE VIEW</div><h2>Authorized screen share</h2></div><button className="button button-stop" onClick={() => closeViewer()}>Close viewer <X size={15} /></button></div><video ref={videoRef} autoPlay muted playsInline /><p>The user can stop sharing at any time. Video is not recorded or stored.</p></section>}
      <div className="dashboard-footnote"><LockKeyhole size={15} /> This dashboard is private. All sign-ins and session endings are audit logged.</div>
    </main>
  </div>;
}

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/admin') return <AdminDashboard />;
  if (path === '/admin/login') return <AdminLogin />;
  return <Landing />;
}

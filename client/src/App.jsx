import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  ArrowDown, ArrowRight, CalendarDays, ChevronDown, Eye,
  EyeOff, Flower2, LockKeyhole, MapPin, Menu, Monitor,
  Music2, Palette, ShieldCheck, Sparkles, Ticket, Utensils, X
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

function FestivalHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  return <header className="festival-header">
    <a className="festival-brand" href="#top" aria-label="Rang Utsav home">
      <span className="festival-brand-mark"><Flower2 size={22} /></span>
      <span>rang<span className="brand-amp">&</span>utsav<small>JAIPUR · INDIA</small></span>
    </a>
    <button className="festival-menu-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
      {menuOpen ? <X size={21} /> : <Menu size={21} />}
    </button>
    <nav className={`festival-nav ${menuOpen ? 'open' : ''}`}>
      <a href="#experience" onClick={closeMenu}>The festival</a>
      <a href="#program" onClick={closeMenu}>What’s on</a>
      <a href="#visit" onClick={closeMenu}>Plan your visit</a>
      <a href="#faq" onClick={closeMenu}>FAQs</a>
      <a className="festival-nav-cta" href="#passes" onClick={closeMenu}>Get the details <ArrowRight size={15} /></a>
    </nav>
  </header>;
}

function ShareControl({ onStateChange, onContinue }) {
  const [state, setState] = useState('idle');
  const [message, setMessage] = useState('');
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const peerRef = useRef(null);
  const sessionRef = useRef(null);
  const pendingSignalsRef = useRef([]);
  const pendingCandidatesRef = useRef([]);

  useEffect(() => { onStateChange?.(state); }, [onStateChange, state]);

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
      : 'An authorized support administrator will be able to view the screen or window you select. Your browser will ask you first, and you remain in control throughout the session.'}</p>
    {state !== 'sharing' ? <button className="button button-dark full" onClick={start} disabled={state === 'requesting'}>
      {state === 'requesting' ? 'Waiting for browser permission…' : 'Choose a screen to share'} <ArrowRight size={16} />
    </button> : <button className="button button-stop full" onClick={() => stop()}>Stop sharing <X size={16} /></button>}
    {onContinue && <button type="button" className="entry-continue-button" onClick={onContinue}>Continue to festival <ArrowRight size={16} /></button>}
    {message && <div className="inline-message" role="status">{message}</div>}
    <div className="privacy-note"><LockKeyhole size={15} /> Nothing is captured or transmitted without browser permission.</div>
  </div>;
}

function PublicEntry() {
  const [entered, setEntered] = useState(false);
  const [shareState, setShareState] = useState('idle');
  const enterFestival = () => setEntered(true);

  useEffect(() => {
    if (!entered) document.title = 'Before You Enter — Rang & Utsav';
  }, [entered]);

  return <div className={`entry-page ${entered ? 'is-entered' : ''}`}>
    {!entered && <>
      <header className="entry-header">
        <a className="festival-brand" href="/" aria-label="Rang Utsav">
          <span className="festival-brand-mark"><Flower2 size={22} /></span>
          <span>rang<span className="brand-amp">&</span>utsav<small>JAIPUR · INDIA</small></span>
        </a>
      </header>
      <main className="entry-main">
        <div className="festival-kicker"><span /> BEFORE YOU ENTER</div>
        <h1>One quick choice<br /><em>is yours to make.</em></h1>
        <p>This site offers optional screen sharing for people receiving support. If you choose it, an authorized support administrator can view the screen or window you select, live. Your browser will show its own permission prompt first.</p>
        <p className="entry-choice-note">Sharing is optional. You can continue to the festival without sharing anything.</p>
      </main>
    </>}
    <div className={`entry-share-shell ${entered ? (shareState === 'sharing' ? 'is-docked' : 'is-hidden') : ''}`}>
      <ShareControl onStateChange={setShareState} onContinue={entered ? undefined : enterFestival} />
    </div>
    {!entered && <p className="entry-footer-note">Only share a screen or window you are comfortable showing. You can stop sharing at any time.</p>}
    {entered && <Landing />}
  </div>;
}

function Landing() {
  useEffect(() => { document.title = 'Rang & Utsav — A festival of colour, culture & connection'; }, []);
  return <div className="festival-page" id="top">
    <div className="festival-ribbon"><Sparkles size={14} /> THE CITY’S MOST COLOURFUL WEEKEND <span>·</span> 20–21 MARCH 2027 <Sparkles size={14} /></div>
    <FestivalHeader />
    <main>
      <section className="festival-hero">
        <div className="hero-sunburst" aria-hidden="true"><div className="sunburst-core"><span>रंग</span><i>✳</i></div></div>
        <div className="festival-hero-copy">
          <div className="festival-kicker"><span /> TWO DAYS. A THOUSAND STORIES.</div>
          <h1>Come for the<br />colour. <em>Stay for</em><br /><em>the feeling.</em></h1>
          <p>Music in the air, colour on your sleeves, and a little more joy than you came with. Jaipur, let’s celebrate together.</p>
          <div className="festival-hero-actions"><a className="festival-button festival-button-dark" href="#experience">Discover the festival <ArrowRight size={17} /></a><a className="festival-play-link" href="#program"><span><ArrowDown size={15} /></span> Explore the programme</a></div>
          <div className="festival-hero-meta"><span><CalendarDays size={16} /> 20—21 March, 2027</span><i /><span><MapPin size={16} /> Jaipur, Rajasthan</span></div>
        </div>
        <div className="festival-hero-art" role="img" aria-label="Illustration of a colourful festival evening with music, lights and dancing">
          <div className="art-glow" /><div className="art-moon">✺</div>
          <div className="art-garland"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
          <div className="art-stage"><div className="stage-sun" /><div className="stage-arch" /><div className="stage-light light-a" /><div className="stage-light light-b" /><div className="stage-person person-a" /><div className="stage-person person-b" /><div className="stage-person person-c" /><div className="stage-floor" /></div>
          <div className="art-flower flower-a">✿</div><div className="art-flower flower-b">✳</div><div className="art-flower flower-c">✿</div>
          <div className="art-caption"><span>JAIPUR, INDIA</span><b>A celebration<br />of being together.</b><i>20—21 · 03 · 27</i></div>
          <div className="art-side-note">A LITTLE MORE COLOUR, A LOT MORE JOY</div>
        </div>
        <div className="hero-edge-label">RANG · RAAG · RISHTE</div>
      </section>
      <div className="festival-facts" aria-label="Festival details">
        <span className="facts-label">SAVE THE WEEKEND</span>
        <div><CalendarDays /><span><small>WHEN</small>20—21 March, 2027</span></div>
        <div><MapPin /><span><small>WHERE</small>Jaipur, Rajasthan</span></div>
        <div><Music2 /><span><small>THE MOOD</small>Music · art · togetherness</span></div>
        <a href="#program">See what’s on <ArrowRight size={15} /></a>
      </div>
      <section className="festival-intro" id="experience">
        <div className="intro-side-note">A FESTIVAL FOR ALL THE SENSES <span>✳</span></div>
        <div className="festival-section-heading"><div className="festival-kicker"><span /> NOT JUST A FESTIVAL. A FEELING.</div><h2>Two days to find<br />your <em>kind of joy.</em></h2></div>
        <div className="festival-intro-copy"><p>Follow the dhol, find your people, and let the day unfold. Rang & Utsav brings the sounds, flavours and handmade wonders of Rajasthan together for one big, open-hearted celebration.</p><a className="festival-text-link" href="#visit">Get to know the festival <ArrowRight size={16} /></a></div>
      </section>
      <section className="festival-experiences">
        <article className="experience-card experience-music"><div className="experience-card-top"><span>01 / HEAR</span><Music2 /></div><div className="experience-illustration music-illustration"><i className="music-disc" /><i className="music-wave wave-one" /><i className="music-wave wave-two" /><i className="music-wave wave-three" /><span>♪</span></div><div><h3>Feel the rhythm.</h3><p>Folk roots meet fresh sounds. Come for one song, stay for the encore.</p></div><a href="#program" aria-label="Explore the music programme"><ArrowUpRightIcon /></a></article>
        <article className="experience-card experience-colour"><div className="experience-card-top"><span>02 / MAKE</span><Palette /></div><div className="experience-illustration colour-illustration"><div className="colour-ring ring-one" /><div className="colour-ring ring-two" /><div className="colour-ring ring-three" /><div className="colour-center">रंग</div><i className="colour-dot dot-one" /><i className="colour-dot dot-two" /><i className="colour-dot dot-three" /></div><div><h3>Make a little magic.</h3><p>Get hands-on with colour, craft and joyful little experiments.</p></div><a href="#program" aria-label="Explore art and colour activities"><ArrowUpRightIcon /></a></article>
        <article className="experience-card experience-taste"><div className="experience-card-top"><span>03 / TASTE</span><Utensils /></div><div className="experience-illustration taste-illustration"><div className="taste-sun" /><div className="taste-plate"><i /><i /><i /><i /><i /></div><span>GOOD FOOD<br />GOOD COMPANY</span></div><div><h3>Follow the aroma.</h3><p>Street-food favourites, family recipes and something sweet to finish.</p></div><a href="#program" aria-label="Explore festival food"><ArrowUpRightIcon /></a></article>
      </section>
      <section className="festival-program" id="program">
        <div className="program-heading"><div><div className="festival-kicker festival-kicker-light"><span /> YOUR WEEKEND, YOUR WAY</div><h2>Make room<br />for <em>the unexpected.</em></h2></div><p>Wander between stages, join a workshop, or find a shady spot and let the music come to you.</p></div>
        <div className="program-days"><article className="program-day">        <div className="day-date"><span>SAT</span><b>20</b><small>MAR</small></div><div className="day-copy"><span>DAY ONE · FROM 4 PM</span><h3>First lights, first notes.</h3><p>Welcome circle · folk rhythms · twilight market</p></div><ArrowRight /></article><article className="program-day"><div className="day-date"><span>SUN</span><b>21</b><small>MAR</small></div><div className="day-copy"><span>DAY TWO · FROM 11 AM</span><h3>Stay for the whole story.</h3><p>Colour courtyard · makers’ bazaar · live finale</p></div><ArrowRight /></article></div>
        <div className="program-foot"><span>* Programme details will be announced soon.</span><a href="#passes">Keep me in the loop <ArrowRight size={15} /></a></div>
      </section>
      <section className="festival-visit" id="visit">
        <div className="visit-art"><div className="visit-sun" /><div className="visit-horizon" /><div className="visit-dune dune-back" /><div className="visit-dune dune-front" /><div className="visit-palace"><i /><i /><i /><i /><b /></div><div className="visit-stamp">JAIPUR<br /><span>राजस्थान</span></div><span className="visit-flower">✳</span></div>
        <div className="visit-copy"><div className="festival-kicker"><span /> MAKE A DAY OF IT</div><h2>Meet us where<br />the <em>city glows.</em></h2><p>Under open skies, with Jaipur’s warm evening light around us. Bring your friends, your dancing shoes, and your appetite for discovery.</p><div className="visit-details"><div><MapPin /><span><b>Festival grounds</b><small>Jaipur, Rajasthan, India</small></span></div><div><CalendarDays /><span><b>20—21 March, 2027</b><small>Two days of music, art & food</small></span></div></div><a className="festival-text-link" href="#passes">Plan your festival weekend <ArrowRight size={16} /></a></div>
      </section>
      <section className="festival-pass-banner" id="passes"><div className="pass-flower pass-flower-left">✳</div><div className="pass-flower pass-flower-right">✿</div><div className="festival-kicker festival-kicker-light"><span /> THE FIRST NOTE IS YOURS</div><h2>Make this one<br /><em>your tradition.</em></h2><p>Bring your people. Leave with a story. The full programme and ticket information are coming soon.</p><a className="festival-button festival-button-cream" href="#program"><Ticket size={17} /> Explore the weekend <ArrowRight size={16} /></a></section>
      <section className="festival-faq" id="faq"><div><div className="festival-kicker"><span /> A FEW THINGS TO KNOW</div><h2>Good to<br /><em>know.</em></h2><p>Got another question? We’re happy to help make your visit a lovely one.</p><a className="festival-text-link" href="#visit">Plan your visit <ArrowRight size={15} /></a></div><div className="festival-faq-list"><details><summary>When and where is Rang & Utsav? <ChevronDown /></summary><p>Join us on 20–21 March, 2027 in Jaipur, Rajasthan. Festival grounds and arrival details will be announced with the full programme.</p></details><details><summary>What should I bring? <ChevronDown /></summary><p>Bring comfortable shoes, a reusable water bottle and your curiosity. We’ll post practical venue guidance closer to the festival.</p></details><details><summary>Is the festival family-friendly? <ChevronDown /></summary><p>Rang & Utsav is imagined as a welcoming gathering for all ages. Detailed accessibility and family information will be shared before the event.</p></details></div></section>
    </main>
    <footer className="festival-footer"><a className="festival-brand" href="#top"><span className="festival-brand-mark"><Flower2 size={21} /></span><span>rang<span className="brand-amp">&</span>utsav<small>JAIPUR · INDIA</small></span></a><span className="footer-note">Made for the moments we make together.</span><span>© 2026 Rang & Utsav</span></footer>
  </div>;
}

function ArrowUpRightIcon() {
  return <ArrowRight size={17} className="arrow-diagonal" />;
}

function SharingPage() {
  useEffect(() => { document.title = 'Private Support Session — Rang & Utsav'; }, []);
  return <div className="sharing-page">
    <header className="sharing-header"><a className="festival-brand" href="/"><span className="festival-brand-mark"><Flower2 size={21} /></span><span>rang<span className="brand-amp">&</span>utsav<small>JAIPUR · INDIA</small></span></a><a className="sharing-back" href="/">Back to festival <ArrowRight size={15} /></a></header>
    <main className="sharing-main"><div className="festival-kicker"><span /> PRIVATE SUPPORT SESSION</div><h1>Share your screen<br /><em>only if you choose.</em></h1><p className="sharing-intro">An authorized support administrator can view only the screen or window you select. Your browser will ask you to approve before anything is shared. You can stop at any time.</p><ShareControl /><p className="sharing-safety"><LockKeyhole size={15} /> Nothing is captured or transmitted before you approve your browser’s screen-sharing prompt.</p></main>
  </div>;
}

function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    document.title = 'Administrator Sign In — Rang & Utsav';
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

  useEffect(() => { document.title = 'Admin Dashboard — Rang & Utsav'; }, []);

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
  if (path === '/share') return <SharingPage />;
  return <PublicEntry />;
}

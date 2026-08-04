"use client";

import { useEffect, useRef, useState } from "react";

const githubUrl = "https://github.com/NeedMeSomeAnimeTiddy/Fovea";
const featureSlideCount = 6;
const labTargets = [
  {
    label: "Slide title",
    kind: "Text anchor",
    bounds: { left: "29.2%", top: "28.3%", width: "57%", height: "27%" },
    asks: [
      { question: "What is this slide trying to say?", answer: "The slide is a blank presentation template: a large title placeholder with a supporting subtitle below it." },
      { question: "Suggest a stronger title", answer: "Try: “A clearer way to understand your screen” — it keeps the idea direct and leaves room for the visual to do the work." },
      { question: "Make this more concise", answer: "Use a short headline with one concrete promise. Fovea can keep the title and subtitle in view while you refine them." },
    ],
  },
  {
    label: "Subtitle placeholder",
    kind: "Control · Text",
    bounds: { left: "29.2%", top: "55.8%", width: "57%", height: "18.8%" },
    asks: [
      { question: "What belongs in this field?", answer: "A single supporting sentence that gives the title context. Keep it to one idea so the slide stays easy to scan." },
      { question: "Write a subtitle for Fovea", answer: "Select anything on your screen. Get a focused answer, then keep asking without leaving the moment." },
      { question: "How should I format this?", answer: "Use sentence case, one line if possible, and enough contrast against the white slide background." },
    ],
  },
  {
    label: "Presentation ribbon",
    kind: "Control",
    bounds: { left: "42.5%", top: "4.5%", width: "15%", height: "10%" },
    asks: [
      { question: "What does this area control?", answer: "It is the presentation ribbon: the place to change slide layout, typography, drawing tools, and other editing commands." },
      { question: "Where do I change the layout?", answer: "Use the Layout control in the Home ribbon. Fovea can point you to the visible control instead of describing the whole toolbar." },
      { question: "What should I click next?", answer: "Choose Layout if you want a different placeholder arrangement, or click the selected text box to edit its content." },
    ],
  },
  {
    label: "Slide thumbnail",
    kind: "Navigation",
    bounds: { left: "1.5%", top: "16.2%", width: "13.5%", height: "14%" },
    asks: [
      { question: "What is this small panel for?", answer: "It is the slide navigator. The outlined thumbnail is the active slide; more slides would stack underneath it." },
      { question: "How do I duplicate this slide?", answer: "Select the thumbnail, open its context menu, and choose Duplicate Slide. Fovea can extract the visible label or explain the menu." },
      { question: "Can you summarize this slide?", answer: "It is currently an empty title slide, with one title placeholder and one subtitle placeholder ready for content." },
    ],
  },
  {
    label: "Window controls",
    kind: "Chrome",
    bounds: { left: "91.5%", top: "0%", width: "8.5%", height: "5%" },
    asks: [
      { question: "What are these buttons?", answer: "They minimize, maximize, or close the presentation window. Fovea can identify the visible control without needing the app name." },
      { question: "Which one closes the window?", answer: "The X at the far right closes the current window. Fovea can highlight it as a control target." },
      { question: "Ask a follow-up", answer: "Select another visible target or add another snip to keep the same conversation grounded in the screen." },
    ],
  },
] as const;

function ApertureMark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? "aperture aperture--small" : "aperture"} aria-hidden="true">
      <span className="aperture__core" />
    </span>
  );
}

function ArrowIcon() {
  return <span aria-hidden="true">↗</span>;
}

export default function Home() {
  const [downloadNote, setDownloadNote] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeFeature, setActiveFeature] = useState(0);
  const [carouselPlaying, setCarouselPlaying] = useState(true);
  const featureTrackRef = useRef<HTMLDivElement>(null);
  const [labTarget, setLabTarget] = useState(0);
  const [labAsk, setLabAsk] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    const savedTheme = window.localStorage.getItem("fovea-site-theme");
    const initialTheme = savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    root.dataset.theme = initialTheme;
    window.setTimeout(() => setTheme(initialTheme), 0);
    let ticking = false;

    const updateScroll = () => {
      const range = document.documentElement.scrollHeight - window.innerHeight;
      root.style.setProperty("--scroll", `${range > 0 ? window.scrollY / range : 0}`);
      ticking = false;
    };

    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(updateScroll);
        ticking = true;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      root.style.setProperty("--pointer-x", `${event.clientX}px`);
      root.style.setProperty("--pointer-y", `${event.clientY}px`);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add("is-visible");
        });
      },
      { threshold: 0.18 },
    );

    document.querySelectorAll("[data-reveal]").forEach((item) => observer.observe(item));
    updateScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  useEffect(() => {
    if (!carouselPlaying || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const interval = window.setInterval(() => {
      setActiveFeature((current) => {
        const next = (current + 1) % featureSlideCount;
        const track = featureTrackRef.current;
        const slide = track?.children.item(next) as HTMLElement | null;
        if (track && slide) {
          const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
          const requestedScroll = slide.offsetLeft - track.offsetLeft;
          track.scrollTo({ left: Math.min(maxScroll, Math.max(0, requestedScroll)), behavior: "smooth" });
        }
        return next;
      });
    }, 7200);

    return () => window.clearInterval(interval);
  }, [carouselPlaying]);

  const showDownloadNote = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setDownloadNote(true);
    window.setTimeout(() => setDownloadNote(false), 2400);
  };

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("fovea-site-theme", nextTheme);
    setTheme(nextTheme);
  };

  const goToFeature = (index: number, userInitiated = true) => {
    const next = (index + featureSlideCount) % featureSlideCount;
    const track = featureTrackRef.current;
    const slide = track?.children.item(next) as HTMLElement | null;
    if (track && slide) {
      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      const requestedScroll = slide.offsetLeft - track.offsetLeft;
      track.scrollTo({ left: Math.min(maxScroll, Math.max(0, requestedScroll)), behavior: "smooth" });
    }
    setActiveFeature(next);
    if (userInitiated) setCarouselPlaying(false);
  };

  const syncFeatureIndex = () => {
    const track = featureTrackRef.current;
    if (!track) return;
    const slides = Array.from(track.children) as HTMLElement[];
    const centre = track.scrollLeft + track.clientWidth / 2;
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    slides.forEach((slide, index) => {
      const delta = Math.abs(slide.offsetLeft + slide.clientWidth / 2 - centre);
      if (delta < distance) { distance = delta; closest = index; }
    });
    setActiveFeature(closest);
  };

  const selectLabTarget = (index: number) => {
    setLabTarget(index);
    setLabAsk(0);
  };

  const selectedLabTarget = labTargets[labTarget];
  const selectedLabAsk = selectedLabTarget.asks[labAsk];

  return (
    <main>
      <div className="scroll-progress" aria-hidden="true" />
      <div className="pointer-light" aria-hidden="true" />

      <header className="site-header">
        <a className="brand" href="#top" aria-label="Fovea home">
          <ApertureMark small />
          <span>Fovea</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#features">Features</a>
          <a href="#ask-lab">Ask lab</a>
          <a href="#under-the-hood">Details</a>
        </nav>
        <div className="header-actions">
          <button
            className="theme-toggle"
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-pressed={theme === "light"}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            <span className="theme-toggle__track" aria-hidden="true">
              <span className="theme-toggle__sun">☼</span>
              <span className="theme-toggle__moon">☾</span>
              <i />
            </span>
          </button>
          <a className="header-link" href={githubUrl} target="_blank" rel="noreferrer">
            GitHub <ArrowIcon />
          </a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero__ambient hero__ambient--one" aria-hidden="true" />
        <div className="hero__ambient hero__ambient--two" aria-hidden="true" />

        <div className="hero__copy" data-reveal>
          <div className="eyebrow"><span /> Windows-first visual assistant</div>
          <h1>
            See it.
            <span>Ask it.</span>
          </h1>
          <p className="hero__dek">
            Select anything on your screen. Fovea turns the moment into a focused answer—and keeps the conversation moving.
          </p>
          <div className="hero__actions">
            <a className="button button--primary" href="#" onClick={showDownloadNote}>
              <span className="windows-mark" aria-hidden="true">⊞</span>
              Download for Windows
            </a>
            <a className="button button--glass" href={githubUrl} target="_blank" rel="noreferrer">
              View on GitHub <ArrowIcon />
            </a>
          </div>
          <p className="release-note">Windows 10/11 · Open source · Installer coming soon</p>
        </div>

        <div className="hero-stage" aria-label="Fovea selecting and explaining an item on screen" data-reveal>
          <div className="stage-orbit stage-orbit--outer" aria-hidden="true" />
          <div className="stage-orbit stage-orbit--inner" aria-hidden="true" />
          <div className="screen-card">
            <div className="screen-card__bar">
              <div className="screen-card__dots"><i /><i /><i /></div>
              <span>Design review · Fovea</span>
              <i className="status-dot" />
            </div>
            <div className="screen-card__canvas">
              <div className="canvas-sidebar">
                <i /><i /><i /><i />
              </div>
              <div className="canvas-content">
                <span className="canvas-kicker" />
                <span className="canvas-title" />
                <span className="canvas-copy" />
                <div className="canvas-grid"><i /><i /><i /></div>
              </div>
              <div className="selection-box">
                <span className="selection-box__label">Selected</span>
                <i className="corner corner--tl" /><i className="corner corner--tr" />
                <i className="corner corner--bl" /><i className="corner corner--br" />
              </div>
            </div>
          </div>

          <div className="answer-card glass-panel">
            <div className="answer-card__head">
              <ApertureMark small />
              <div><strong>Fovea</strong><span>Ready</span></div>
              <span className="answer-card__live" />
            </div>
            <p>This card highlights the selected workspace. Want a concise summary or the details behind it?</p>
            <div className="quick-actions"><span>Summarise</span><span>Explain</span><span>Ask more</span></div>
          </div>
          <div className="shortcut-chip glass-panel"><kbd>Ctrl</kbd><b>+</b><kbd>Shift</kbd><b>+</b><kbd>Space</kbd></div>
          <span className="detection-chip detection-chip--text glass-panel"><i /> Text</span>
          <span className="detection-chip detection-chip--link glass-panel"><i /> Link</span>
          <span className="detection-chip detection-chip--control glass-panel"><i /> Control</span>
        </div>

        <a className="scroll-cue" href="#how-it-works">
          <span>Scroll to explore</span><i aria-hidden="true" />
        </a>
      </section>

      <section className="proof-strip" aria-label="Fovea at a glance">
        <div className="proof-item" data-reveal><strong>5</strong><span>custom capture shortcuts</span></div>
        <div className="proof-item" data-reveal><strong>3</strong><span>local OCR paths</span></div>
        <div className="proof-item" data-reveal><strong>6</strong><span>editing tools</span></div>
        <div className="proof-item proof-item--accent" data-reveal><strong>0</strong><span>analytics or telemetry</span></div>
      </section>

      <section className="story" id="how-it-works">
        <div className="story__intro" data-reveal>
          <p className="section-label">One shortcut. Zero context switching.</p>
          <h2>Stay with what<br />you’re looking at.</h2>
        </div>

        <div className="story__track">
          <div className="story-visual" aria-hidden="true">
            <div className="focus-rings"><i /><i /><i /></div>
            <div className="focus-window glass-panel">
              <div className="focus-window__top"><span /><span>FOVEA · CAPTURE</span><span /></div>
              <div className="focus-window__body">
                <div className="focus-target"><i /><i /><i /><i /></div>
                <div className="scan-line" />
              </div>
            </div>
          </div>

          <div className="story-steps">
            <article className="story-step" data-reveal>
              <span className="step-number">01</span>
              <div className="step-icon">⌗</div>
              <h3>Capture precisely.</h3>
              <p>Draw around the exact part of your screen you care about. Nothing more.</p>
            </article>
            <article className="story-step" data-reveal>
              <span className="step-number">02</span>
              <div className="step-icon">✦</div>
              <h3>Understand instantly.</h3>
              <p>Get a focused visual answer without leaving your flow or opening another tab.</p>
            </article>
            <article className="story-step" data-reveal>
              <span className="step-number">03</span>
              <div className="step-icon">↳</div>
              <h3>Keep asking.</h3>
              <p>Follow up naturally. Add another snip whenever the conversation needs more context.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="features" id="features">
        <div className="features__heading" data-reveal>
          <p className="section-label">Made for real screens</p>
          <h2>Quietly capable.</h2>
          <p>The useful parts stay close. The complicated parts stay out of your way.</p>
        </div>

        <div className={`feature-carousel ${carouselPlaying ? "is-playing" : "is-paused"}`}>
          <div className="carousel-toolbar">
            <div className="carousel-status" aria-live="polite">
              <span>{String(activeFeature + 1).padStart(2, "0")}</span>
              <i key={`${activeFeature}-${carouselPlaying}`} />
              <small>{String(featureSlideCount).padStart(2, "0")}</small>
            </div>
            <div className="carousel-actions">
              <button type="button" onClick={() => goToFeature(activeFeature - 1)} aria-label="Previous feature">←</button>
              <button
                className="carousel-play"
                type="button"
                onClick={() => setCarouselPlaying((playing) => !playing)}
                aria-label={carouselPlaying ? "Pause automatic carousel" : "Resume automatic carousel"}
                aria-pressed={!carouselPlaying}
              >
                {carouselPlaying ? "Ⅱ" : "▶"}<span>{carouselPlaying ? "Pause" : "Play"}</span>
              </button>
              <button type="button" onClick={() => goToFeature(activeFeature + 1)} aria-label="Next feature">→</button>
            </div>
          </div>

          <div
            className="feature-track"
            ref={featureTrackRef}
            role="region"
            aria-roledescription="carousel"
            aria-label="Fovea feature demonstrations"
            tabIndex={0}
            onScroll={syncFeatureIndex}
            onWheel={() => setCarouselPlaying(false)}
            onTouchStart={() => setCarouselPlaying(false)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") { event.preventDefault(); goToFeature(activeFeature - 1); }
              if (event.key === "ArrowRight") { event.preventDefault(); goToFeature(activeFeature + 1); }
            }}
          >
            <article className="feature-slide" role="group" aria-roledescription="slide" aria-label="1 of 6: Analyze the whole screen">
              <div className="feature-slide__visual demo-screen demo-screen--analyze">
                <img src="/demos/security.png" alt="Windows Security screen with Fovea identifying visible controls and text" draggable={false} />
                <div className="demo-image-shade" />
                <span className="overlay-box overlay-box--account"><b>Control · Account protection</b><i /><i /><i /><i /></span>
                <span className="overlay-box overlay-box--virus"><b>Card · Virus protection</b><i /><i /><i /><i /></span>
                <span className="overlay-box overlay-box--firewall"><b>Card · Firewall</b><i /><i /><i /><i /></span>
                <div className="demo-legend glass-panel"><span><i className="legend-control" />Controls <b>12</b></span><span><i className="legend-text" />Text <b>18</b></span><span><i className="legend-link" />Links <b>4</b></span></div>
                <div className="demo-fovea-panel glass-panel">
                  <div><ApertureMark small /><span><b>Analyze complete</b><small>34 visible targets found locally</small></span></div>
                  <p>Select any outlined item to ask what it does, extract its text, or verify it.</p>
                </div>
              </div>
              <div className="feature-slide__content">
                <span className="slide-kicker">SCREEN INTELLIGENCE</span>
                <h3>Map what’s actually visible.</h3>
                <p>Analyze freezes the current desktop, then finds visible controls, text, links, and faces without letting hidden windows leak into the result.</p>
                <ul><li>Targets appear progressively</li><li>Overlapping results are merged</li><li>Click again to cycle stacked targets</li></ul>
              </div>
            </article>

            <article className="feature-slide" role="group" aria-roledescription="slide" aria-label="2 of 6: Local text extraction">
              <div className="feature-slide__visual demo-screen demo-screen--ocr">
                <img src="/demos/weather.png" alt="Windows Weather screen with a Fovea OCR selection and extracted values" draggable={false} />
                <div className="demo-image-shade" />
                <span className="overlay-box overlay-box--weather"><b>OCR region · 98%</b><i /><i /><i /><i /></span>
                <div className="ocr-detail-panel glass-panel">
                  <div className="detail-panel-title"><ApertureMark small /><span><b>Text extracted locally</b><small>Windows OCR · 86 ms</small></span></div>
                  <div className="ocr-transcript"><strong>11°C</strong><span>Mostly cloudy</span><span>Humidity 81%</span><span>Visibility 10 km</span></div>
                  <div className="ocr-action-row"><i>Copy all</i><i>Ask about this</i></div>
                </div>
                <span className="source-badge glass-panel"><i /> Stayed on this device</span>
              </div>
              <div className="feature-slide__content">
                <span className="slide-kicker">LOCAL OCR</span>
                <h3>Turn pixels into usable text.</h3>
                <p>Fovea compares local recognition paths, keeps the stronger result, and exposes useful details without sending the image to a model.</p>
                <ul><li>Windows OCR with offline fallback</li><li>Preserves columns and wide gaps</li><li>Recognizes links, contacts, QR and barcodes</li></ul>
              </div>
            </article>

            <article className="feature-slide" role="group" aria-roledescription="slide" aria-label="3 of 6: Focused visual answers">
              <div className="feature-slide__visual demo-screen demo-screen--answer">
                <img src="/demos/powerpoint.png" alt="PowerPoint screen with the subtitle area selected and a focused Fovea answer" draggable={false} />
                <div className="demo-image-shade" />
                <span className="overlay-box overlay-box--subtitle"><b>Selected region</b><i /><i /><i /><i /></span>
                <div className="answer-detail-panel glass-panel">
                  <div className="detail-panel-title"><ApertureMark small /><span><b>Fovea</b><small>Focused on your selection</small></span></div>
                  <p>This is the subtitle placeholder. Click inside it and type the supporting line for your slide.</p>
                  <div className="answer-suggestions"><i>Make it concise</i><i>Suggest a subtitle</i><i>Explain the layout</i></div>
                </div>
                <span className="capture-size glass-panel">1095 × 203 px</span>
              </div>
              <div className="feature-slide__content">
                <span className="slide-kicker">VISUAL ANSWERS</span>
                <h3>Ask about the exact thing.</h3>
                <p>Only the chosen region and question continue to the response window, so answers stay grounded in the detail you meant.</p>
                <ul><li>Four contextual follow-up suggestions</li><li>Add another snip mid-conversation</li><li>Regenerate without losing the transcript</li></ul>
              </div>
            </article>

            <article className="feature-slide" role="group" aria-roledescription="slide" aria-label="4 of 6: Edit before sending">
              <div className="feature-slide__visual demo-screen demo-screen--edit">
                <img src="/demos/powerpoint.png" alt="PowerPoint capture being annotated and redacted in Fovea" draggable={false} />
                <div className="demo-image-shade demo-image-shade--strong" />
                <span className="overlay-box overlay-box--edit-region"><b>Editing capture</b><i /><i /><i /><i /></span>
                <span className="demo-redaction" aria-label="Example redacted area" />
                <span className="demo-annotation" aria-hidden="true">↗</span>
                <div className="editor-toolbar glass-panel" aria-hidden="true"><i>↶</i><i>↗</i><i>□</i><i>✎</i><i>◌</i><i>▰</i><b>Send</b></div>
                <div className="edit-note glass-panel"><b>Solid redaction</b><small>Pixels removed from the derivative</small></div>
              </div>
              <div className="feature-slide__content">
                <span className="slide-kicker">CAPTURE EDITOR</span>
                <h3>Show the point. Hide the rest.</h3>
                <p>Mark up a frozen capture before it becomes context. The edited derivative replaces the original temporary source.</p>
                <ul><li>Arrows, shapes, drawing and text</li><li>Blur or irreversible solid redaction</li><li>Undo, redo and save a local copy</li></ul>
              </div>
            </article>

            <article className="feature-slide" role="group" aria-roledescription="slide" aria-label="5 of 6: Contextual quick actions">
              <div className="feature-slide__visual demo-screen demo-screen--actions">
                <img src="/demos/explorer.png" alt="Windows File Explorer context menu with Fovea quick actions" draggable={false} />
                <div className="demo-image-shade" />
                <span className="overlay-box overlay-box--menu"><b>Visible menu · 14 items</b><i /><i /><i /><i /></span>
                <div className="quick-menu glass-panel">
                  <div><ApertureMark small /><span><b>New</b><small>Menu item · 94%</small></span></div>
                  <button type="button" tabIndex={-1}><i>✦</i><span><b>What does this do?</b><small>Ask Fovea</small></span></button>
                  <button type="button" tabIndex={-1}><i>Aa</i><span><b>Extract its text</b><small>Keep it local</small></span></button>
                  <button type="button" tabIndex={-1}><i>⌕</i><span><b>Verify with web search</b><small>Approval required</small></span></button>
                </div>
              </div>
              <div className="feature-slide__content">
                <span className="slide-kicker">CONTEXTUAL ACTIONS</span>
                <h3>Go from finding to doing.</h3>
                <p>Every detected target can open a tiny action menu, keeping common questions and local extraction one click away.</p>
                <ul><li>Preset questions adapt to the target</li><li>Copy recognized text immediately</li><li>Web verification always asks first</li></ul>
              </div>
            </article>

            <article className="feature-slide" role="group" aria-roledescription="slide" aria-label="6 of 6: Deliberately scoped privacy">
              <div className="feature-slide__visual demo-screen demo-screen--privacy">
                <img src="/demos/weather.png" alt="Weather screen dimmed outside a selected Fovea region" draggable={false} />
                <div className="demo-image-shade" />
                <span className="privacy-selection"><b>Only this region continues</b><i /><i /><i /><i /></span>
                <div className="privacy-detail-panel glass-panel">
                  <div className="detail-panel-title"><ApertureMark small /><span><b>Deliberately scoped</b><small>Before asking</small></span></div>
                  <ul><li><span>✓</span> Selected pixels only</li><li><span>✓</span> No Fovea analytics</li><li><span>✓</span> Private mode available</li><li><span>✓</span> Temporary source cleaned</li></ul>
                </div>
                <span className="source-badge source-badge--private glass-panel"><i /> Ready to send securely</span>
              </div>
              <div className="feature-slide__content">
                <span className="slide-kicker">PRIVACY CONTROLS</span>
                <h3>Share a question, not your desktop.</h3>
                <p>Fovea keeps scope visible: the chosen pixels, the chosen question, and the OpenAI sign-in mode you selected.</p>
                <ul><li>No Fovea account or backend</li><li>No analytics or telemetry</li><li>Configurable local history retention</li></ul>
              </div>
            </article>
          </div>

          <div className="carousel-footer">
            <div className="carousel-dots" role="group" aria-label="Choose a feature">
              {Array.from({ length: featureSlideCount }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  className={activeFeature === index ? "is-active" : ""}
                  onClick={() => goToFeature(index)}
                  aria-label={`Show feature ${index + 1}`}
                  aria-current={activeFeature === index ? "true" : undefined}
                ><i /></button>
              ))}
            </div>
            <p>Drag, scroll, use arrow keys, or let Fovea guide the tour.</p>
            <a href="https://huggingface.co/datasets/bevaya/ScreenSpot" target="_blank" rel="noreferrer">Demo screens: ScreenSpot · Apache-2.0 <ArrowIcon /></a>
          </div>
        </div>
      </section>

      <section className="ask-lab" id="ask-lab" data-reveal>
        <div className="ask-lab__heading">
          <div>
            <p className="section-label">Try the moment</p>
            <h2>Click a square.<br />Ask a better question.</h2>
          </div>
          <p>Fovea’s Analyze mode maps the visible screen, then turns a target into a small menu of useful questions. Pick any outlined area to see what the conversation could sound like.</p>
        </div>

        <div className="ask-lab__shell">
          <div className="ask-lab__screen" role="application" aria-label="Interactive PowerPoint screen demo. Choose a highlighted target.">
            <img src="/demos/powerpoint.png" alt="A busy PowerPoint desktop screen with interactive Fovea targets" draggable={false} />
            <div className="ask-lab__scrim" aria-hidden="true" />
            <div className="ask-lab__chrome glass-panel"><ApertureMark small /><span>ANALYZE · CLICK A TARGET</span><i>LIVE DEMO</i></div>
            {labTargets.map((target, index) => (
              <button
                key={target.label}
                type="button"
                className={`lab-target ${labTarget === index ? "is-selected" : ""}`}
                style={target.bounds}
                onClick={() => selectLabTarget(index)}
                aria-label={`Ask about ${target.label}`}
                aria-pressed={labTarget === index}
              >
                <span><b>{String(index + 1).padStart(2, "0")}</b>{target.label}</span>
                <i /><i /><i /><i />
              </button>
            ))}
            <div className="ask-lab__hint glass-panel"><span>⌗</span> Five visible targets · choose one</div>
          </div>

          <aside className="ask-lab__inspector" aria-live="polite">
            <div className="ask-lab__inspector-top">
              <span className="inspector-icon"><ApertureMark small /></span>
              <div><small>SELECTED TARGET</small><b>{selectedLabTarget.label}</b></div>
              <span className="inspector-kind">{selectedLabTarget.kind}</span>
            </div>
            <p className="ask-lab__prompt-label">Example Ask questions</p>
            <div className="ask-lab__questions">
              {selectedLabTarget.asks.map((ask, index) => (
                <button key={ask.question} type="button" className={labAsk === index ? "is-active" : ""} onClick={() => setLabAsk(index)}>
                  <span>{ask.question}</span><i>↗</i>
                </button>
              ))}
            </div>
            <div className="ask-lab__answer">
              <div><span>Fovea would answer</span><i>● ready</i></div>
              <p>{selectedLabAsk.answer}</p>
            </div>
            <div className="ask-lab__next"><span>⌘</span><p>Choose another target to keep the same conversation grounded in the screen.</p></div>
          </aside>
        </div>
      </section>

      <section className="details" id="under-the-hood">
        <div className="details__heading" data-reveal>
          <p className="section-label">Small touches. Serious utility.</p>
          <h2>Built for the way<br />screens actually behave.</h2>
          <p>Fovea does more than answer a screenshot. It handles the awkward parts around the answer.</p>
        </div>

        <div className="detail-bento">
          <article className="detail-panel detail-panel--history" data-reveal>
            <div className="detail-panel__top"><span className="detail-icon">↺</span><small>CONVERSATIONS</small></div>
            <h3>Pick up where you left off.</h3>
            <p>Search and reopen past conversations, regenerate the latest response, or switch on private mode when nothing should be kept.</p>
            <div className="history-stack" aria-hidden="true">
              <span><i className="history-thumb history-thumb--one" /><b>Design review</b><small>2 minutes ago</small></span>
              <span><i className="history-thumb history-thumb--two" /><b>Translate this sign</b><small>Yesterday</small></span>
              <span><i className="history-thumb history-thumb--three" /><b>Explain this chart</b><small>Tuesday</small></span>
            </div>
          </article>

          <article className="detail-panel detail-panel--shortcuts" data-reveal>
            <div className="detail-panel__top"><span className="detail-icon">⌘</span><small>SHORTCUTS</small></div>
            <h3>One gesture away.</h3>
            <p>Assign shortcuts for a region, display, window, repeat-last action, or settings.</p>
            <div className="shortcut-list" aria-hidden="true">
              <span><b>Region</b><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd></span>
              <span><b>Window</b><em>Set shortcut</em></span>
              <span><b>Repeat last</b><em>Set shortcut</em></span>
            </div>
          </article>

          <article className="detail-panel detail-panel--search" data-reveal>
            <div className="detail-panel__top"><span className="detail-icon">⌕</span><small>WEB VERIFICATION</small></div>
            <div className="search-approval" aria-hidden="true">
              <span className="search-orb">✦</span>
              <b>Search the web to verify this?</b>
              <small>Fovea always asks first.</small>
              <div><i>Not now</i><i>Allow search</i></div>
            </div>
            <h3>Curiosity, with permission.</h3>
            <p>When visible clues need current context, Fovea can request a focused web search. You stay in control.</p>
          </article>

          <article className="detail-panel detail-panel--documents" data-reveal>
            <div className="detail-panel__top"><span className="detail-icon">Aa</span><small>DOCUMENT OCR</small></div>
            <h3>More than neat screenshots.</h3>
            <p>Fovea can straighten photographed pages, preserve wide column gaps, and recover small or low-contrast text.</p>
            <div className="document-visual" aria-hidden="true"><span /><span /><span /><span /></div>
          </article>
        </div>
      </section>

      <section className="privacy-flow" data-reveal>
        <div className="privacy-flow__copy">
          <p className="section-label">Deliberately scoped</p>
          <h2>The pixels you choose.<br />Not your whole digital life.</h2>
          <p>Local extraction stays on your machine. For visual questions, only the chosen capture continues through your selected OpenAI sign-in—without a Fovea account, backend, or analytics layer.</p>
        </div>
        <div className="privacy-flow__diagram" aria-label="Chosen screen region flows to a focused answer">
          <div className="flow-node"><span className="flow-screen"><i /></span><b>Your screen</b><small>Choose a region</small></div>
          <span className="flow-arrow" aria-hidden="true">→</span>
          <div className="flow-node flow-node--active"><span className="flow-aperture"><ApertureMark small /></span><b>Fovea</b><small>Crop · edit · redact</small></div>
          <span className="flow-arrow" aria-hidden="true">→</span>
          <div className="flow-node"><span className="flow-answer">Aa</span><b>Your answer</b><small>Focused context</small></div>
        </div>
      </section>

      <section className="capability-strip" aria-label="Fovea capabilities">
        <div className="marquee">
          <span>Screen capture</span><i />
          <span>Visual answers</span><i />
          <span>Local OCR</span><i />
          <span>Annotations</span><i />
          <span>Redaction</span><i />
          <span>Conversation history</span><i />
          <span>QR & barcodes</span><i />
          <span>Permissioned search</span><i />
          <span>Screen capture</span><i />
          <span>Visual answers</span><i />
          <span>Local OCR</span><i />
        </div>
      </section>

      <section className="final-cta" data-reveal>
        <div className="final-cta__glow" aria-hidden="true" />
        <ApertureMark />
        <p className="section-label">Built for Windows</p>
        <h2>Your screen has<br />more to say.</h2>
        <p>Fovea helps you ask the right question, right where it appears.</p>
        <div className="hero__actions">
          <a className="button button--primary" href="#" onClick={showDownloadNote}>
            <span className="windows-mark" aria-hidden="true">⊞</span>
            Download for Windows
          </a>
          <a className="button button--glass" href={githubUrl} target="_blank" rel="noreferrer">
            Explore the source <ArrowIcon />
          </a>
        </div>
      </section>

      <footer>
        <a className="brand" href="#top"><ApertureMark small /><span>Fovea</span></a>
        <p>See it. Ask it.</p>
        <a href={githubUrl} target="_blank" rel="noreferrer">GitHub <ArrowIcon /></a>
      </footer>

      <div className={`download-toast ${downloadNote ? "is-showing" : ""}`} role="status" aria-live="polite">
        <span>●</span> The Windows installer is coming soon.
      </div>
    </main>
  );
}

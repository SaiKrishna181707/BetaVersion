import { useEffect, useRef, useState } from 'react';
import { Badge, Brand, Icon, type IconName } from '@synthetic-beta/ui';
import { SessionIllustration } from '../components/SessionIllustration';
import BorderGlow, { type BorderGlowProps } from '../components/reactbits/BorderGlow';
import Carousel, { type CarouselItem } from '../components/reactbits/Carousel';
import CountUp from '../components/reactbits/CountUp';
import ShinyText from '../components/reactbits/ShinyText';

const workflow: { number: string; icon: IconName; title: string; text: string; detail: string }[] = [
  { number: '01', icon: 'globe', title: 'Give them a goal.', text: 'Your product. Your audience. One objective. Set the boundaries before a session begins.', detail: 'DEFINE THE TEST' },
  { number: '02', icon: 'cursor', title: 'Let them find their way.', text: 'Autonomous agents explore the actual interface. They can take wrong turns, retry, or abandon.', detail: 'OBSERVE REAL INTERACTION' },
  { number: '03', icon: 'activity', title: 'Follow the evidence.', text: 'Trace friction to recorded actions and session IDs. Decide what to fix with measured outcomes.', detail: 'INSPECT THE RESULTS' },
];

/** The enforced limits below are the same numbers the executor respects. */
const signals: { value: number; label: string; detail: string }[] = [
  { value: 100, label: 'USERS PER RUN', detail: 'Independent browser sessions, batched so a run stays bounded.' },
  { value: 40, label: 'ACTIONS PER SESSION', detail: 'Recorded as evidence, so a finding can be traced back to a step.' },
  { value: 180, label: 'SECONDS PER SESSION', detail: 'The default budget before a session stops and reports itself.' },
];

const showcase: CarouselItem[] = [
  { id: 1, title: 'Population preview', description: 'The audience a run will simulate, before a single session starts.', icon: <Icon name="users" className="carousel-icon" size={16} /> },
  { id: 2, title: 'Session traces', description: 'Every action, in order, with the screen each step landed on.', icon: <Icon name="activity" className="carousel-icon" size={16} /> },
  { id: 3, title: 'Evidence', description: 'Pointers and captures attached to the finding that claims them.', icon: <Icon name="file" className="carousel-icon" size={16} /> },
  { id: 4, title: 'Friction findings', description: 'Where sessions stalled, retried, or walked away from the objective.', icon: <Icon name="layers" className="carousel-icon" size={16} /> },
  { id: 5, title: 'Run report', description: 'Metrics and a cost breakdown for what the run actually spent.', icon: <Icon name="terminal" className="carousel-icon" size={16} /> },
];

/** One glow configuration for every card, so the marketing page stays consistent. */
const glowCard: BorderGlowProps = {
  glowColor: '278 92 74',
  backgroundColor: '#150F24',
  borderRadius: 22,
  glowRadius: 36,
  coneSpread: 26,
  colors: ['#a855f7', '#6366f1', '#e879f9'],
};

/** The carousel takes a pixel width, so the section is measured instead of guessed. */
function useCarouselWidth(maxWidth: number) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);

  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    const measure = () => {
      setWidth(Math.round(Math.max(280, Math.min(element.clientWidth, maxWidth))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maxWidth]);

  return [host, width] as const;
}

export function LandingPage() {
  const [carouselHost, carouselWidth] = useCarouselWidth(520);

  // The workspace routes on the hash, so in-page navigation scrolls instead of linking.
  const scrollToSection = (id: string) => () => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return <div className="landing-page"><header className="landing-header container"><Brand /><nav aria-label="Main navigation"><button type="button" className="quiet-link" onClick={scrollToSection('workflow')}>How it works</button><button type="button" className="quiet-link" onClick={scrollToSection('showcase')}>What you get</button><a className="button button-secondary header-cta" href="#/new">Open workspace <Icon name="arrow" size={15} /></a></nav></header>
    <main id="main"><section className="hero container" aria-labelledby="hero-heading"><div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line" /><ShinyText text="PRODUCT TESTING, WITH EVIDENCE" speed={4.5} spread={110} color="#b9a3e6" shineColor="#f8f0ff" pauseOnHover /></div><h1 id="hero-heading">Deploy synthetic users.<br /><span>Watch where your product breaks.</span></h1><p className="hero-description">Find obvious UX and product failures before spending time recruiting human beta users.</p><p className="hero-detail">Autonomous browser agents. Actual interaction.<br />Every finding tied to what happened.</p><div className="hero-actions"><a className="button button-primary button-large" href="#/new">Deploy synthetic users <Icon name="arrow" size={17} /></a><button type="button" className="text-link" onClick={scrollToSection('workflow')}>See the workflow <Icon name="chevron" size={13} /></button></div><div className="hero-guardrail"><Icon name="shield" size={14} /><span>Authorized targets. Explicit limits. You stay in control.</span></div></div><BorderGlow {...glowCard} animated borderRadius={26} glowRadius={46} coneSpread={30} className="lux-card hero-glow"><SessionIllustration /></BorderGlow></section>
    <div className="scope-strip container"><span className="scope-label"><span className="dot" /> BUILT FOR THE WEB</span><span>One objective per run</span><span>Independent browser sessions</span><span>Evidence before assumptions</span></div>
    <section className="signals container" aria-label="Run limits">{signals.map(signal => <BorderGlow {...glowCard} key={signal.label} className="lux-card"><div className="signal"><strong className="signal-value"><CountUp to={signal.value} duration={1.8} /></strong><span className="signal-label mono">{signal.label}</span><p>{signal.detail}</p></div></BorderGlow>)}</section>
    <section id="workflow" className="workflow container" aria-labelledby="workflow-heading"><div className="workflow-heading"><h2 id="workflow-heading">A goal in. Evidence out.</h2><Badge>THE WORKFLOW</Badge></div><div className="workflow-grid">{workflow.map(step => <BorderGlow {...glowCard} key={step.number} className="lux-card"><article className="workflow-step"><div className="workflow-step-top"><span className="mono">{step.number}</span><Icon name={step.icon} size={20} /></div><h3>{step.title}</h3><p>{step.text}</p><span className="step-detail mono">{step.detail}</span></article></BorderGlow>)}</div></section>
    <section id="showcase" className="showcase container" aria-labelledby="showcase-heading"><div className="showcase-heading"><h2 id="showcase-heading">What one run hands back.</h2><Badge>DRAG IT</Badge></div><div className="showcase-carousel" ref={carouselHost}><Carousel items={showcase} baseWidth={carouselWidth} autoplay autoplayDelay={4200} pauseOnHover loop /></div></section>
    <section className="principle container"><Icon name="users" size={19} /><p><strong>An earlier signal. A better starting point.</strong><span>Synthetic sessions help you spot friction. They do not replace research with real people.</span></p><a className="text-link" href="#/new">Create your first run <Icon name="arrow" size={16} /></a></section></main>
    <footer className="landing-footer container"><span>Synthetic Beta <span className="footer-separator">/</span> Observe. Understand. Improve.</span><span className="footer-build mono">FOUNDATION PREVIEW <span className="dot" /></span></footer>
  </div>;
}
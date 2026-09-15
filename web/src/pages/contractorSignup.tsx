import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import { ArrowLeft, ArrowRight, Check, CheckCheck, Copy, Download, LoaderCircle, MessageCircle, Plus, Sparkles, UserRoundPlus } from 'lucide-react';
import { FormLogo } from '@/components/ui/FormLogo';
import { useContractorSignup, type DesignAgentContact } from '@/api/contractors';
import { contractorSignupSchema, type ContractorSignupData } from '@/schema/contractor';
import { downloadFormContact, formatContactPhone } from '@/lib/contractorContact';
import './contractorSignup.css';

const steps = ['Your details', 'Start a chat', 'Save FORM'];
const sessionKey = 'form-contractor-onboarding';
type OnboardingSession = { firstName: string; agent: DesignAgentContact; step: 1 | 2 };

function readSession(): OnboardingSession | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    if (saved && typeof saved.firstName === 'string' && saved.agent?.name === 'FORM'
      && /^\+[1-9]\d{7,14}$/.test(saved.agent.phone) && [1, 2].includes(saved.step)
      && (saved.agent.email === null || typeof saved.agent.email === 'string')
      && (saved.agent.website === null || typeof saved.agent.website === 'string')) return saved;
  } catch { /* Browsers may disable storage. The flow still works in memory. */ }
  return null;
}

export default function ContractorSignupPage() {
  const [session, setSession] = useState(readSession);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [contactRequested, setContactRequested] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const optionalDetails = useRef<HTMLDetailsElement>(null);
  const submissionId = useRef(crypto.randomUUID());
  const signup = useContractorSignup();
  const step = session?.step ?? 0;
  const agent = session?.agent;
  const form = useForm<ContractorSignupData>({
    resolver: valibotResolver(contractorSignupSchema),
    defaultValues: { firstName: '', lastName: '', businessName: '', phone: '', email: '', website: '', licenseNumber: '' },
    mode: 'onTouched',
  });

  useEffect(() => {
    document.title = 'Get started with FORM';
    document.querySelector('meta[name="description"]')?.setAttribute('content', 'Get FORM’s number and bring design support to your next kitchen bid, all by text.');
  }, []);

  useEffect(() => {
    if (step > 0) heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [step]);

  useEffect(() => {
    try {
      if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
      else sessionStorage.removeItem(sessionKey);
    } catch { /* Storage is optional. */ }
  }, [session]);

  async function onSubmit(values: ContractorSignupData) {
    if (signup.isPending) return;
    try {
      const result = await signup.mutateAsync({ ...values, submissionId: submissionId.current });
      setSession({ firstName: values.firstName, agent: result.agent, step: 1 });
    } catch { /* The mutation error is rendered beside the submit button. */ }
  }

  function startAnotherSignup() {
    submissionId.current = crypto.randomUUID();
    form.reset();
    signup.reset();
    setCopied(false);
    setCopyError(false);
    setContactRequested(false);
    setSession(null);
    window.scrollTo(0, 0);
  }

  async function copyNumber() {
    if (!agent) return;
    try {
      await navigator.clipboard.writeText(agent.phone);
      setCopied(true);
      setCopyError(false);
    } catch { setCopyError(true); }
  }

  function input(name: keyof ContractorSignupData, label: string, placeholder: string,
    autoComplete: string, type = 'text', optional = false) {
    const error = form.formState.errors[name];
    return (
      <div className="signup-field">
        <label htmlFor={name}>{label}{optional && <span>Optional</span>}</label>
        <input id={name} type={type} placeholder={placeholder} autoComplete={autoComplete}
          inputMode={name === 'website' ? 'url' : undefined}
          maxLength={name === 'website' ? 2048 : name === 'email' ? 254 : name === 'phone' ? 40 : name === 'businessName' ? 150 : 100}
          aria-required={!optional} aria-invalid={!!error}
          aria-describedby={error ? `${name}-error` : name === 'phone' ? 'phone-hint' : undefined}
          {...form.register(name)} />
        {error && <p id={`${name}-error`} className="signup-field-error" role="alert">{error.message}</p>}
      </div>
    );
  }

  return (
    <div className="contractor-signup">
      <header className="signup-header form-container">
        <Link to="/" aria-label="FORM home"><FormLogo size={112} /></Link>
        <span className="signup-header-label">FOR CONTRACTORS</span>
        <div className="signup-signin"><Link to="/">Back to FORM <ArrowRight size={14} /></Link></div>
      </header>

      <main className="signup-layout form-container">
        <aside className="signup-story">
          <div className="signup-story-copy">
            <span className="signup-eyebrow"><span /> BUILT FOR KITCHEN REMODELERS</span>
            <h2>You build.<br />We bring the design.</h2>
            <p>Help your client picture their new kitchen.<br />Work through the details together by text.</p>
          </div>
          <img className="signup-story-image" src="/kitchen-sample.jpg" alt="A bright kitchen with custom cabinetry and a warm wood island" />
          <div className="signup-story-note"><MessageCircle size={21} /><div><strong>Your client. Your project. Design support.</strong><span>Kitchen ideas and feedback, in one conversation.</span></div></div>
          <span className="signup-image-credit">DESIGN INSPIRATION</span>
        </aside>

        <section className="signup-content" aria-label="Contractor signup">
          <ol className="signup-progress" aria-label="Signup progress">
            {steps.map((label, index) => <li key={label} className={index < step ? 'is-complete' : index === step ? 'is-current' : ''}
              aria-current={index === step ? 'step' : undefined}>
              <span className="signup-step-number">{index < step ? <Check size={13} /> : `0${index + 1}`}</span>
              <span>{label}</span>
            </li>)}
          </ol>

          <div className="signup-step-content" key={step}>
            {step === 0 && <>
              <div className="signup-intro"><span className="signup-eyebrow">START WITH YOUR NEXT KITCHEN</span>
                <h1 ref={heading} tabIndex={-1}>Give your next kitchen bid an edge.</h1>
                <p>Get FORM’s number. Share a kitchen photo and give your client a design they’re excited to build.</p>
              </div>
              <form onSubmit={form.handleSubmit(onSubmit, (errors) => {
                if ((errors.website || errors.licenseNumber) && optionalDetails.current) {
                  optionalDetails.current.open = true;
                }
              })} noValidate>
                <fieldset disabled={signup.isPending} className="signup-fields">
                  <legend className="sr-only">Your contractor details</legend>
                  <div className="signup-field-row">
                    {input('firstName', 'First name', 'First name', 'given-name')}
                    {input('lastName', 'Last name', 'Last name', 'family-name')}
                  </div>
                  <div>
                    {input('phone', 'Mobile number', '+1 (415) 555-0123', 'tel', 'tel')}
                    {!form.formState.errors.phone && <p id="phone-hint" className="signup-field-hint">Use the number you’ll text FORM from.</p>}
                  </div>
                  {input('email', 'Email address', 'you@company.com', 'email', 'email')}
                  {input('businessName', 'Business name', 'Your business name', 'organization', 'text', true)}
                  <details ref={optionalDetails} className="signup-optional-details">
                    <summary>Website &amp; license <span>Optional</span></summary>
                    <div>
                      {input('website', 'Business website', 'yourcompany.com', 'url', 'text', true)}
                      {input('licenseNumber', 'Contractor license number', 'Your license number', 'off', 'text', true)}
                    </div>
                  </details>
                </fieldset>
                {signup.isError && <div className="signup-submit-error" role="alert">{signup.error instanceof Error && signup.error.message !== 'Failed to fetch'
                  ? signup.error.message : 'We couldn’t connect. Please check your connection and try again.'}</div>}
                <button type="submit" className="signup-primary" disabled={signup.isPending}>
                  {signup.isPending ? <><LoaderCircle className="signup-spinner" size={18} /> Getting FORM’s number…</> : <>Get design support for my next bid <ArrowRight size={18} /></>}
                </button>
                <p className="signup-footnote">No app to download. Start with a text.</p>
              </form>
            </>}

            {step === 1 && session && agent && <>
              <div className="signup-intro"><span className="signup-eyebrow signup-success"><Check size={14} /> YOU’RE IN, {session.firstName.toLocaleUpperCase()}</span>
                <h1 ref={heading} tabIndex={-1}>Start with a<br />kitchen photo.</h1>
                <p>Text FORM a kitchen photo and a quick introduction. Use the phone number you signed up with so FORM recognizes you. For a shared project, start an iMessage group with your homeowner before sending photos.</p>
              </div>
              <div className="signup-agent-preview">
                <div className="signup-agent-heading"><div className="signup-agent-avatar">F<span><Plus size={10} /></span></div>
                  <div><strong>FORM</strong><span>Your AI design agent</span></div><MessageCircle size={21} /></div>
                <div className="signup-conversation"><span className="signup-conversation-label">A SIMPLE WAY TO GET STARTED</span>
                  <div className="signup-message">Hi FORM, I’m {session.firstName}. I have a kitchen project for a client. Here’s the space we’re working with.</div>
                  <div className="signup-message-caption">Send a photo, then share what your client wants to change.</div>
                </div>
                <div className="signup-agent-capabilities"><span><Check size={13} /> Kitchen ideas</span><span><Check size={13} /> Design revisions</span><span><Check size={13} /> Saved decisions</span></div>
              </div>
              <a className="signup-primary signup-messages-button" href={`sms:${agent.phone}`}>
                <MessageCircle size={19} /> Open FORM in Messages <ArrowRight size={18} />
              </a>
              <p className="signup-footnote">This opens a direct text to FORM. If you prefer a shared iMessage group, create it first and share the project there.</p>
              <div className="signup-copy-number"><span>Or message <strong>{formatContactPhone(agent.phone)}</strong></span>
                <button type="button" onClick={copyNumber} aria-label={copied ? 'Number copied' : 'Copy phone number'}>{copied ? <CheckCheck size={16} /> : <Copy size={16} />}</button></div>
              <p className="signup-copy-status" role="status">{copyError ? 'Select the number above to copy it manually.' : copied ? 'Number copied.' : ''}</p>
              <button type="button" className="signup-next-link" onClick={() => setSession({ ...session, step: 2 })}>Next: save FORM to your contacts <ArrowRight size={16} /></button>
            </>}

            {step === 2 && session && agent && <>
              <div className="signup-intro"><span className="signup-eyebrow">ONE LAST THING</span>
                <h1 ref={heading} tabIndex={-1}>Keep good<br />design close.</h1>
                <p>Save FORM’s number so it’s easy to find. Keep this project’s photos and feedback in the conversation where you started it.</p>
              </div>
              <div className="signup-contact-card">
                <div className="signup-contact-top"><FormLogo size={120} /><span>YOUR DESIGN PARTNER</span></div>
                <div className="signup-contact-body"><div className="signup-contact-title"><h2>FORM</h2><UserRoundPlus size={23} /></div>
                  <p>Your AI design agent</p>
                  <dl><dt>mobile</dt><dd>{formatContactPhone(agent.phone)}</dd>
                    {agent.email && <><dt>email</dt><dd>{agent.email}</dd></>}
                    {agent.website && <><dt>website</dt><dd>{agent.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</dd></>}
                  </dl>
                </div>
                <div className="signup-contact-bottom"><Sparkles size={14} /> Kitchen design support, one text away.</div>
              </div>
              <button type="button" className="signup-primary" onClick={() => {
                downloadFormContact(agent); setContactRequested(true);
              }}><Download size={18} /> {contactRequested ? 'Download contact card again' : 'Download FORM’s contact card'} <ArrowRight size={18} /></button>
              <div className="signup-contact-instructions" role="status">{contactRequested
                ? <>Open <strong>FORM.vcf</strong>, then choose “Create New Contact” or “Add to Contacts” to finish saving.</>
                : 'Opens a contact card you can save on your phone or computer.'}</div>
              <a className="signup-next-link" href={`sms:${agent.phone}`}>Open FORM in Messages <MessageCircle size={16} /></a>
              <button type="button" className="signup-back" onClick={() => setSession({ ...session, step: 1 })}><ArrowLeft size={14} /> Back to your agent</button>
            </>}
          </div>
          {session && <button type="button" className="signup-back" onClick={startAnotherSignup}>Sign up another contractor</button>}
          <div className="signup-content-footer"><span>BUILT FOR THE WAY YOU WORK</span><span>FORM © {new Date().getFullYear()}</span></div>
        </section>
      </main>
    </div>
  );
}

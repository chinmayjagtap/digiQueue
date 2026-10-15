import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, usePolling } from './api';
import { dateTime, errorKey, money, translate } from './i18n';
import type { Language, TextKey } from './i18n';
import type { Account, Bootstrap, Denomination, Deposit, QueueData } from './types';

type Ui = { language: Language; t: (key: TextKey) => string };
const denominations = [500, 200, 100, 50, 20, 10];
const reasons: TextKey[] = [
  'DENOMINATION_MISMATCH', 'AMOUNT_MISMATCH', 'UNSUITABLE_NOTES',
  'ACCOUNT_ISSUE', 'CUSTOMER_WITHDREW', 'OTHER',
];
const tokenName = (number: number) => `C-${String(number).padStart(3, '0')}`;

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : 'SERVER_ERROR'); }
    finally { running.current = false; setBusy(false); }
  };
  return { busy, error, setError, run };
}

function Alert({ code, t }: { code: string } & Pick<Ui, 't'>) {
  return code ? <div className="alert error" role="alert">{t(errorKey(code))}</div> : null;
}

function Button({ children, busy = false, secondary = false, ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; busy?: boolean; secondary?: boolean }) {
  return <button {...props} disabled={busy || props.disabled}
    className={`${secondary ? 'button secondary' : 'button'} ${props.className || ''}`}
    aria-busy={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}{children}</button>;
}

function NotesTable({ rows, t }: { rows: Denomination[] } & Pick<Ui, 't'>) {
  return <div className="table-wrap"><table className="notes-table">
    <thead><tr><th>{t('denomination')}</th><th>{t('quantity')}</th><th>{t('amount')}</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.denomination}>
      <td>{money(row.denomination)}</td><td>{row.quantity}</td>
      <td>{money(row.denomination * row.quantity)}</td>
    </tr>)}</tbody>
  </table></div>;
}

function SlipDetails({ deposit, t, language, history = false }: { deposit: Deposit; history?: boolean } & Ui) {
  return <>
    <dl className="details">
      <div><dt>{t('accountHolder')}</dt><dd>{deposit.full_name}</dd></div>
      <div><dt>{t('account')}</dt><dd className="mono">{deposit.account_number}</dd></div>
      <div><dt>{t('branch')}</dt><dd>{deposit.branch_code}</dd></div>
      <div><dt>{t('submitted')}</dt><dd>{dateTime(deposit.created_at, language)}</dd></div>
    </dl>
    <NotesTable rows={deposit.denominations} t={t} />
    <div className="total"><span>{t('total')}</span><strong>{money(deposit.total_amount)}</strong></div>
    {deposit.rejection_code && <div className="alert error">
      <strong>{t(deposit.rejection_code)}</strong>
      {deposit.rejection_note && <p>{deposit.rejection_note}</p>}
    </div>}
    <p className="notice">{t('requestOnly')}</p>
    <div className="reference">{t('reference')}<br /><span className="mono">{deposit.id}</span></div>
    {history && <section className="history"><h3>{t('history')}</h3>
      <ol>{deposit.events.map((event, index) => <li key={index}>
        <span>{t(event.event_type)}</span><time>{dateTime(event.created_at, language)}</time>
      </li>)}</ol>
    </section>}
  </>;
}

export function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = localStorage.getItem('dq.language');
    return stored === 'mr' || stored === 'hi' ? stored : 'en';
  });
  const t = useCallback((key: TextKey) => translate(language, key), [language]);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<TextKey | null>(null);
  const [staffScreen, setStaffScreen] = useState(location.hash === '#staff');
  const [revision, setRevision] = useState(0);
  const pendingBoot = useRef<Promise<Bootstrap> | null>(null);
  const load = useCallback(async () => {
    setError('');
    try {
      // Share initial requests so concurrent mounts cannot create competing session cookies.
      pendingBoot.current ||= api<Bootstrap>('/bootstrap');
      setBoot(await pendingBoot.current);
    }
    catch (error) { setError(error instanceof Error ? error.message : 'SERVER_ERROR'); }
    finally { pendingBoot.current = null; }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem('dq.language', language);
  }, [language]);
  useEffect(() => {
    const listener = () => setStaffScreen(location.hash === '#staff');
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  const reset = useCallback(async (idle = false) => {
    setBoot(null);
    setError('');
    setNotice(idle ? 'idleReset' : null);
    try {
      await api('/bootstrap');
      await api('/logout', {});
      location.hash = '';
      setStaffScreen(false);
      setRevision((value) => value + 1);
      setBoot(await api<Bootstrap>('/bootstrap'));
    } catch (error) { setError(error instanceof Error ? error.message : 'SERVER_ERROR'); }
  }, []);
  const ui = { language, t };
  const staff = Boolean(boot?.staff);
  return <div className={`app ${staff ? 'staff-app' : ''}`}>
    <header className="topbar">
      <a className="brand" href="#" onClick={(event) => event.preventDefault()} aria-label="DigiQueue">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span>Digi<span className="brand-light">Queue</span><small>{t('tagline')}</small></span>
      </a>
      <nav className="languages" aria-label="Language / भाषा">
        {(['en', 'mr', 'hi'] as Language[]).map((lang) => <button key={lang}
          aria-pressed={language === lang} onClick={() => setLanguage(lang)} lang={lang}>
          {{ en: 'English', mr: 'मराठी', hi: 'हिन्दी' }[lang]}
        </button>)}
      </nav>
    </header>
    <div className="demo-strip"><strong>{t('demo')}</strong><span>{t('demoNote')}</span></div>
    <main>
      {notice && <div className="alert info" role="status">{t(notice)}</div>}
      <Alert code={error} t={t} />
      {!boot ? <div className="loading-screen">
        {error ? <Button onClick={() => void load()}>{t('retry')}</Button> : <p role="status">{t('loading')}</p>}
      </div> : staff ? <StaffDashboard {...ui} onLogout={reset} />
        : staffScreen ? <StaffLogin {...ui} onLogin={load} onBack={() => { location.hash = ''; setStaffScreen(false); }} />
          : <Customer key={revision} {...ui} boot={boot} onReset={reset}
            onStaff={() => { setNotice(null); location.hash = 'staff'; setStaffScreen(true); }} />}
    </main>
    <footer>DigiQueue <span>·</span> {staff ? 'DEMO001' : t('idle')}</footer>
  </div>;
}

function Customer({ boot, onReset, onStaff, ...ui }: Ui & {
  boot: Bootstrap; onReset: (idle?: boolean) => Promise<void>; onStaff: () => void;
}) {
  const { t, language } = ui;
  const [step, setStep] = useState(boot.activeDepositId ? 'receipt' : boot.customer ? 'account' : 'mobile');
  const [mobile, setMobile] = useState('');
  const [otp, setOtp] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [receiptId, setReceiptId] = useState(boot.activeDepositId || '');
  const [resendAt, setResendAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState(false);
  const submissionKey = useRef(crypto.randomUUID());
  const action = useAction();

  const loadAccounts = useCallback(async () => {
    const result = await api<Account[]>('/accounts');
    setAccounts(result);
    setAccountId(result.length === 1 ? result[0].id : '');
    if (!result.length) throw new Error('NO_ACCOUNT');
  }, []);
  useEffect(() => {
    if (boot.customer && !boot.activeDepositId) {
      void loadAccounts().catch((error) => action.setError(error instanceof Error ? error.message : 'SERVER_ERROR'));
    }
  }, [boot.customer, boot.activeDepositId, loadAccounts]);
  useEffect(() => {
    if (step === 'mobile') return;
    let timer: ReturnType<typeof setTimeout>;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => void onReset(true), 180000); };
    touch();
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
    };
  }, [step, onReset]);
  useEffect(() => {
    const update = () => setSeconds(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [resendAt]);
  const selected = accounts.find((account) => account.id === accountId);
  const rows = denominations.map((denomination) => ({
    denomination, quantity: Number(counts[denomination] || 0),
  })).filter((row) => row.quantity > 0);
  const total = rows.reduce((sum, row) => sum + row.denomination * row.quantity, 0);
  const noteCount = rows.reduce((sum, row) => sum + row.quantity, 0);
  const submitForm = (event: FormEvent, callback: () => Promise<void>) => {
    event.preventDefault();
    void action.run(callback);
  };
  const requestOtp = async () => {
    await api('/otp/request', { mobile });
    setResendAt(Date.now() + 30000);
    setMessage(true);
    setStep('otp');
  };
  const navigate = (next: string) => { action.setError(''); setStep(next); };
  const stepIndex = ['mobile', 'otp', 'account', 'notes', 'review', 'receipt'].indexOf(step);

  if (step === 'receipt') return <CustomerReceipt key={receiptId} {...ui} id={receiptId} onReset={onReset} />;

  return <div className={`customer-layout ${step === 'mobile' ? 'welcome-layout' : ''}`}>
    <aside className="intro">
      <span className="eyebrow">{t('digitalCashDeposit')}</span>
      <h1>{t(step === 'mobile' ? 'welcome' : step === 'otp' ? 'verifyTitle' : step === 'account' ? 'accountTitle' : step === 'notes' ? 'notesTitle' : 'reviewTitle')}</h1>
      <p>{t(step === 'mobile' ? 'welcomeSub' : step === 'otp' ? 'verifySub' : step === 'account' ? 'accountSub' : step === 'notes' ? 'notesSub' : 'reviewSub')}</p>
      {step === 'otp' && <strong className="mobile-display">+91 {mobile}</strong>}
      <div className="step-track" aria-label={`${stepIndex + 1} / 6`}>
        {Array.from({ length: 6 }, (_, index) => <span key={index} className={index <= stepIndex ? 'done' : ''} />)}
      </div>
      <div className="intro-note"><span className="shield" aria-hidden="true">✓</span>{t('privacy')}</div>
    </aside>
    <section className="card customer-card">
      <Alert code={action.error} t={t} />
      {step === 'mobile' && <>
        <form onSubmit={(event) => submitForm(event, requestOtp)}>
          <label htmlFor="mobile">{t('mobile')}</label>
          <p className="field-hint" id="mobile-hint">{t('mobileHint')}</p>
          <div className="phone-input"><span>+91</span><input id="mobile" type="tel" inputMode="numeric"
            autoComplete="tel-national" maxLength={10} pattern="[6-9][0-9]{9}" required
            value={mobile} onChange={(event) => setMobile(event.target.value.replace(/\D/g, ''))}
            placeholder="98765 00001" aria-describedby="mobile-hint" /></div>
          <Button busy={action.busy} type="submit" className="full">{t('sendOtp')} <span aria-hidden="true">→</span></Button>
        </form>
        <div className="demo-customers"><span>{t('demoAccounts')}</span>
          <div>{['9876500001', '9876500002', '9876500003'].map((number) =>
            <button key={number} className="chip mono" onClick={() => setMobile(number)}>{number}</button>)}</div>
        </div>
        <div className="staff-link"><button className="text-button" onClick={onStaff}>{t('staffLogin')} <span aria-hidden="true">↗</span></button></div>
      </>}
      {step === 'otp' && <>
        <div className="alert info">{t('demoOtp')}</div>
        {message && <p className="sr-only" role="status">{t('otpSent')}</p>}
        <form onSubmit={(event) => submitForm(event, async () => {
          await api('/otp/verify', { otp });
          await loadAccounts();
          setStep('account');
        })}>
          <label htmlFor="otp">{t('otp')}</label>
          <input id="otp" className="otp-input" inputMode="numeric" autoComplete="one-time-code"
            maxLength={6} minLength={6} pattern="[0-9]{6}" required value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))} placeholder="— — — — — —" />
          <Button busy={action.busy} className="full" type="submit">{t('verify')}</Button>
        </form>
        <div className="split-actions">
          <button className="text-button" disabled={seconds > 0 || action.busy} onClick={() => void action.run(requestOtp)}>
            {seconds ? `${t('resendWait')} ${seconds}s` : t('resend')}</button>
          <button className="text-button" disabled={action.busy} onClick={() => navigate('mobile')}>{t('changeMobile')}</button>
        </div>
      </>}
      {step === 'account' && <>
        {accounts[0] && <div className="customer-name"><span className="avatar">{accounts[0].full_name[0]}</span>
          <div><small>{t('accountHolder')}</small><strong>{accounts[0].full_name}</strong></div></div>}
        <fieldset className="account-options"><legend>{t('account')}</legend>
          {accounts.map((account) => <label className={`account-option ${accountId === account.id ? 'selected' : ''}`} key={account.id}>
            <input type="radio" name="account" value={account.id} checked={accountId === account.id}
              onChange={() => setAccountId(account.id)} />
            <span><strong className="mono">{account.account_number}</strong><small>{t('branch')} {account.branch_code}</small></span>
          </label>)}
        </fieldset>
        <h3>{t('chooseService')}</h3>
        <div className="service-option selected"><span className="service-icon" aria-hidden="true">₹</span>
          <div><strong>{t('cash')}</strong><small>{t('cashSub')}</small></div><span aria-hidden="true">✓</span></div>
        <div className="service-option disabled" aria-disabled="true"><span className="service-icon" aria-hidden="true">▤</span>
          <div><strong>{t('cheque')}</strong><small>{t('comingSoon')}</small></div></div>
        <Button className="full" busy={action.busy} disabled={!accounts.length} onClick={() => {
          if (!selected) action.setError('selectAccount'); else navigate('notes');
        }}>{t('continue')} <span aria-hidden="true">→</span></Button>
        {!accounts.length && <button className="text-button" onClick={() => void action.run(loadAccounts)}>{t('retry')}</button>}
      </>}
      {step === 'notes' && <>
        <div className="account-summary"><strong>{selected?.full_name}</strong><span className="mono">{selected?.account_number}</span></div>
        <form onSubmit={(event) => submitForm(event, async () => {
          if (Object.values(counts).some((value) => value !== '' && (!/^\d+$/.test(value) || Number(value) > 10000))) {
            throw new Error('invalidQuantity');
          }
          if (!rows.length) throw new Error('emptyNotes');
          if (total > 200000) throw new Error('AMOUNT_LIMIT');
          setStep('review');
        })}>
          <div className="table-wrap"><table className="notes-table editable"><thead><tr>
            <th>{t('denomination')}</th><th>{t('quantity')}</th><th>{t('amount')}</th>
          </tr></thead><tbody>{denominations.map((denomination) => <tr key={denomination}>
            <td><span className="note-badge">{money(denomination)}</span></td>
            <td><input aria-label={`${money(denomination)} · ${t('quantity')}`} type="number" inputMode="numeric"
              min={0} max={10000} step={1} placeholder="0" value={counts[denomination] || ''}
              onChange={(event) => setCounts({ ...counts, [denomination]: event.target.value })} /></td>
            <td>{money(denomination * Number(counts[denomination] || 0))}</td>
          </tr>)}</tbody></table></div>
          <div className="total"><span>{t('total')}<small>{noteCount} {t('totalNotes')}</small></span><strong>{money(total)}</strong></div>
          <p className="field-hint">{t('limit')}</p>
          <Button className="full" type="submit">{t('review')} <span aria-hidden="true">→</span></Button>
        </form>
        <button className="text-button back" onClick={() => navigate('account')}>← {t('back')}</button>
      </>}
      {step === 'review' && selected && <>
        <dl className="details"><div><dt>{t('accountHolder')}</dt><dd>{selected.full_name}</dd></div>
          <div><dt>{t('account')}</dt><dd className="mono">{selected.account_number}</dd></div></dl>
        <NotesTable rows={rows} t={t} />
        <div className="total"><span>{t('total')}</span><strong>{money(total)}</strong></div>
        <p className="notice">{t('requestOnly')}</p>
        <Button busy={action.busy} className="full" onClick={() => void action.run(async () => {
          const deposit = await api<Deposit>('/deposits', {
            accountId, denominations: rows, language, idempotencyKey: submissionKey.current,
          });
          setReceiptId(deposit.id);
          setStep('receipt');
        })}>{t('confirm')}</Button>
        <button className="text-button back" disabled={action.busy} onClick={() => navigate('notes')}>{t('edit')}</button>
      </>}
      {step !== 'mobile' && <button className="text-button reset-link" disabled={action.busy} onClick={() => void onReset()}>{t('reset')}</button>}
    </section>
  </div>;
}

function CustomerReceipt({ id, onReset, ...ui }: Ui & { id: string; onReset: () => Promise<void> }) {
  const { t } = ui;
  const { data, error, refresh } = usePolling<Deposit>(`/deposits/${id}`);
  return <section className="card receipt-card">
    {error && <><Alert code={error} t={t} /><p className="field-hint">{t('reconnecting')}</p></>}
    {!data ? <p role="status">{t('loading')}</p> : <>
      <div className="receipt-heading"><span className="eyebrow">{t('slip')}</span>
        <span className={`status ${data.status}`}>{t(data.status)}</span></div>
      <div className="token-block" aria-live="polite"><span>{t('token')}</span><h1>{data.token}</h1>
        {data.status === 'WAITING' ? <p><strong>{data.ahead}</strong> {t('ahead')}</p>
          : <p className={`outcome ${data.status}`}>{t(data.status === 'CALLED' ? 'calledMessage' :
            data.status === 'ACKNOWLEDGED' ? 'acknowledgedMessage' :
              data.status === 'REJECTED' ? 'rejectedMessage' : 'noShowMessage')}</p>}
      </div>
      <SlipDetails deposit={data} {...ui} />
      <p className="sync-label"><span className="live-dot" />{t('refreshing')}</p>
    </>}
    <div className="receipt-actions no-print">
      <Button onClick={() => void onReset()}>{t('finish')}</Button>
      {data && <Button secondary onClick={() => window.print()}>{t('print')}</Button>}
      {error && <button className="text-button" onClick={refresh}>{t('retry')}</button>}
    </div>
  </section>;
}

function StaffLogin({ onLogin, onBack, t }: Ui & { onLogin: () => Promise<void>; onBack: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();
  return <section className="card login-card"><span className="eyebrow">{t('staffLogin')}</span>
    <h1>{t('staffTitle')}</h1><p className="muted">{t('staffSub')}</p>
    <Alert code={action.error} t={t} />
    <form onSubmit={(event) => { event.preventDefault(); void action.run(async () => {
      await api('/staff/login', { username, password });
      setPassword('');
      await onLogin();
    }); }}>
      <label htmlFor="username">{t('username')}</label>
      <input id="username" autoComplete="username" value={username} required maxLength={100} onChange={(event) => setUsername(event.target.value)} />
      <label htmlFor="password">{t('password')}</label>
      <input id="password" type="password" autoComplete="current-password" value={password} required maxLength={256} onChange={(event) => setPassword(event.target.value)} />
      <Button className="full" type="submit" busy={action.busy}>{t('signIn')}</Button>
    </form>
    <button className="text-button back" onClick={onBack}>← {t('customerScreen')}</button>
  </section>;
}

function StaffDashboard({ onLogout, ...ui }: Ui & { onLogout: () => Promise<void> }) {
  const { t, language } = ui;
  const { data, error, refresh } = usePolling<QueueData>('/staff/queue');
  const [active, setActive] = useState<Deposit | null>(null);
  const [message, setMessage] = useState<TextKey | null>(null);
  const [dialog, setDialog] = useState<'ACKNOWLEDGED' | 'NO_SHOW' | 'REJECTED' | null>(null);
  const [reason, setReason] = useState<TextKey>('DENOMINATION_MISMATCH');
  const [note, setNote] = useState('');
  const action = useAction();
  const mutation = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const version = mutation.current;
    if (!data?.activeId) { setActive(null); return; }
    api<Deposit>(`/staff/deposits/${data.activeId}`)
      .then((deposit) => {
        if (!cancelled && version === mutation.current) setActive(deposit.status === 'CALLED' ? deposit : null);
      })
      .catch((error) => { if (!cancelled) action.setError(error instanceof Error ? error.message : 'SERVER_ERROR'); });
    return () => { cancelled = true; };
  }, [data?.activeId, data?.updatedAt]);

  const call = (id?: string) => void action.run(async () => {
    setMessage(null);
    const deposit = await api<Deposit>(id ? `/staff/deposits/${id}/call` : '/staff/call-next', {});
    mutation.current += 1;
    setActive(deposit);
    refresh();
  });
  const perform = (outcome: string) => void action.run(async () => {
    if (!active) return;
    const deposit = await api<Deposit>(`/staff/deposits/${active.id}/action`, {
      action: outcome, ...(outcome === 'REJECTED' ? { reason, note } : {}),
    });
    mutation.current += 1;
    setDialog(null);
    setNote('');
    if (outcome === 'RECALLED') {
      setActive(deposit);
      setMessage('recalled');
    } else {
      setActive(null);
      setMessage('actionSaved');
    }
    refresh();
  });
  const announce = () => {
    if (!active) return;
    if (!('speechSynthesis' in window)) { action.setError('speechUnavailable'); return; }
    const phrase = new SpeechSynthesisUtterance(
      `${t('token')} ${active.token_number}. ${t('calledMessage')}`,
    );
    phrase.lang = `${language}-IN`;
    phrase.onerror = () => action.setError('speechFailed');
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(phrase);
  };

  return <div className="dashboard">
    <div className="dashboard-heading"><div><span className="eyebrow">DEMO001 · {data?.staff.username}</span>
      <h1>{t('dashboard')}</h1><p>{t('dashboardSub')}</p></div>
      <Button secondary onClick={() => void onLogout()}>{t('logout')}</Button></div>
    <Alert code={error || action.error} t={t} />
    {error && <div className="alert info">{t('reconnecting')} <button className="text-button" onClick={refresh}>{t('retry')}</button>
      <button className="text-button" onClick={() => void onLogout()}>{t('reset')}</button></div>}
    {message && <div className="alert success" role="status">{t(message)}</div>}
    <div className="stats">{(['waiting', 'called', 'acknowledged', 'rejected'] as const).map((key) =>
      <div className={`stat ${key}`} key={key}><span>{t(key)}</span><strong>{data?.summary[key] ?? '—'}</strong></div>)}</div>
    <div className="dashboard-columns">
      <section className="card queue-card">
        <div className="section-heading"><div><h2>{t('queue')}</h2><p className="field-hint">{t('queueHint')}</p></div>
          <Button busy={action.busy} disabled={Boolean(active || data?.activeId) || !data?.summary.waiting || Boolean(error)}
            onClick={() => call()}>{t('callNext')}</Button></div>
        {!data ? <p role="status">{t('loading')}</p> : data.queue.length === 0 ?
          <div className="empty"><div className="empty-icon" aria-hidden="true">✓</div><h3>{t('emptyQueue')}</h3><p>{t('emptyQueueSub')}</p></div> :
          <div className="table-wrap"><table className="queue-table"><thead><tr>
            <th>{t('token')}</th><th>{t('amount')}</th><th>{t('submitted')}</th><th>{t('status')}</th>
          </tr></thead><tbody>{data.queue.map((row) => <tr key={row.id}>
            <td><strong className="queue-token">{tokenName(row.token_number)}</strong></td>
            <td>{money(row.total_amount)}</td><td>{dateTime(row.created_at, language)}</td>
            <td>{row.status === 'WAITING' ? <button className="call-button"
              disabled={Boolean(active || data.activeId) || action.busy || Boolean(error)} onClick={() => call(row.id)}>{t('call')} →</button> :
              <span className={`status ${row.status}`}>{t(row.mine ? 'yours' : 'otherCounter')}</span>}</td>
          </tr>)}</tbody></table></div>}
        <div className="sync-label"><span className="live-dot" />{t('refreshing')}
          {data && <span>{t('lastUpdated')}: {dateTime(data.updatedAt, language)}</span>}</div>
      </section>
      <section className="card counter-card"><div className="section-heading"><h2>{t('activeTitle')}</h2>
        {active && <span className="counter-token">{active.token}</span>}</div>
        {!active ? <div className="empty"><div className="empty-icon" aria-hidden="true">▤</div>
          <h3>{t('noActive')}</h3><p>{t('noActiveSub')}</p></div> : <>
          <SlipDetails deposit={active} {...ui} history />
          <div className="counter-actions">
            <Button busy={action.busy} disabled={Boolean(error)} onClick={() => setDialog('ACKNOWLEDGED')}>{t('acknowledge')}</Button>
            <Button secondary disabled={action.busy || Boolean(error)} onClick={() => { action.setError(''); setDialog('REJECTED'); }}>{t('reject')}</Button>
            <div className="split-actions"><button className="text-button" disabled={action.busy} onClick={() => perform('RECALLED')}>{t('recall')}</button>
              <button className="text-button" disabled={action.busy} onClick={() => setDialog('NO_SHOW')}>{t('noShow')}</button></div>
            <button className="text-button" onClick={announce}>{t('speech')}</button>
          </div>
        </>}
      </section>
    </div>
    {dialog && active && <ActionDialog {...ui} dialog={dialog} active={active}
      error={action.error} busy={action.busy} reason={reason} setReason={setReason}
      note={note} setNote={setNote} onCancel={() => { setDialog(null); action.setError(''); }}
      onConfirm={() => perform(dialog)} />}
  </div>;
}

function ActionDialog({ dialog, active, busy, error, reason, setReason, note, setNote, onCancel, onConfirm, t }: Ui & {
  dialog: 'ACKNOWLEDGED' | 'NO_SHOW' | 'REJECTED'; active: Deposit; busy: boolean; error: string;
  reason: TextKey; setReason: (reason: TextKey) => void; note: string; setNote: (note: string) => void;
  onCancel: () => void; onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="action-dialog" aria-labelledby="dialog-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
      <span className="eyebrow">{active.token} · {money(active.total_amount)}</span>
      <h2 id="dialog-title">{t(dialog === 'REJECTED' ? 'reject' : dialog === 'NO_SHOW' ? 'noShow' : 'acknowledge')}</h2>
      <Alert code={error} t={t} />
      {dialog === 'REJECTED' ? <>
        <label htmlFor="reason">{t('rejectionReason')}</label>
        <select id="reason" value={reason} onChange={(event) => {
          const value = reasons.find((item) => item === event.target.value);
          if (value) setReason(value);
        }}>{reasons.map((value) => <option value={value} key={value}>{t(value)}</option>)}</select>
        <label htmlFor="note">{t('note')}</label>
        <textarea id="note" value={note} maxLength={500} required={reason === 'OTHER'}
          onChange={(event) => setNote(event.target.value)} aria-describedby="note-hint" />
        <p className="field-hint" id="note-hint">{t('noteHint')}</p>
      </> : <p>{t(dialog === 'ACKNOWLEDGED' ? 'acknowledgeConfirm' : 'noShowConfirm')}</p>}
      <div className="dialog-actions"><Button secondary type="button" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button type="submit" busy={busy}>{t(dialog === 'REJECTED' ? 'confirmReject' : 'confirmAction')}</Button></div>
    </form>
  </dialog>;
}

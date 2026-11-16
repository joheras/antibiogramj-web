import { useState } from "react";
import { api, type User } from "../api";

export default function AuthPage({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ email: "", password: "", name: "", lab: "", city: "", country: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(mode === "login" ? await api.login(form.email, form.password) : await api.register(form));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-intro">
        <h1><span className="logo" aria-hidden>◉</span> AntibiogramJ</h1>
        <p>
          Analyse disk-diffusion antibiogram images: detect antibiotic disks, read their codes, measure inhibition
          zones and categorise them as susceptible, intermediate or resistant following EUCAST or CLSI breakpoints.
        </p>
      </div>
      <form className="card auth-card" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button>
        </div>
        <label>E-mail<input type="email" required autoComplete="email" value={form.email} onChange={set("email")} /></label>
        <label>
          Password
          <input type="password" required minLength={mode === "register" ? 8 : undefined}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={form.password} onChange={set("password")} />
        </label>
        {mode === "register" && (
          <>
            <label>Name<input value={form.name} onChange={set("name")} autoComplete="name" /></label>
            <label>Laboratory<input value={form.lab} onChange={set("lab")} autoComplete="organization" /></label>
            <div className="row">
              <label>City<input value={form.city} onChange={set("city")} /></label>
              <label>Country<input value={form.country} onChange={set("country")} autoComplete="country-name" /></label>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{mode === "login" ? "Sign in" : "Create account"}</button>
      </form>
    </div>
  );
}

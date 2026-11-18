import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { firebaseConfig } from "../core/firebase-config.js";


const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);

const loginForm     = document.getElementById('login-form');
const loginEmail    = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginError    = document.getElementById('login-error');
const loginBtnText  = document.getElementById('login-btn-text');

// Só aceita caminho relativo da própria origem — "?redirect=javascript:..."
// ou "?redirect=//site-falso.com" rodava código/phishing na sessão de quem
// clicasse num link do próprio domínio (achado do relatório de segurança de
// 17/11). new URL(valor, origin) resolve "javascript:"/"//outro-site" para
// uma origem diferente, que é recusada abaixo.
function redirectSeguro(valor) {
  const padrao = '/meu-espaco/index.html';
  if (!valor || valor.trim().startsWith('//')) return padrao;
  try {
    const alvo = new URL(valor, window.location.origin);
    if (alvo.origin !== window.location.origin) return padrao;
    return alvo.pathname + alvo.search + alvo.hash;
  } catch (e) {
    return padrao;
  }
}

const urlParams = new URLSearchParams(window.location.search);
const redirectUrl = redirectSeguro(urlParams.get('redirect'));

// Se já estiver logado, vai direto pro Hub ou URL de redirecionamento
onAuthStateChanged(auth, (user) => {
  if (user) window.location.href = redirectUrl;
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.style.display = 'none';
  loginBtnText.textContent = 'Autenticando...';

  try {
    await signInWithEmailAndPassword(auth, loginEmail.value.trim(), loginPassword.value);
    window.location.href = redirectUrl;
  } catch (err) {
    console.error("Login Error:", err);
    loginError.style.display = 'block';
    loginBtnText.textContent = 'Entrar';
  }
});

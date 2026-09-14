/**
 * ÓRBITA - SEGURANÇA E RATE LIMITING
 * Implementação de proteção contra spam e monitoramento de atividades.
 */

const RATE_LIMIT_CONFIG = {
  maxRequestsPerMinute: 30,
  blockDurationMs: 60000, // 1 minuto de bloqueio
};

class RateLimiter {
  constructor() {
    this.requestCounts = {}; // Armazena contagens por usuário (uid)
    this.blockedUsers = {};  // Usuários em cooldown
  }

  /**
   * Verifica se o usuário pode realizar uma ação.
   * @param {string} uid - ID do usuário.
   * @returns {boolean} - true se permitido, false se bloqueado.
   */
  checkLimit(uid) {
    if (!uid) return true;

    const now = Date.now();

    // Verifica se está bloqueado
    if (this.blockedUsers[uid] && now < this.blockedUsers[uid]) {
      console.warn(`[Security] Usuário ${uid} bloqueado por excesso de requisições.`);
      return false;
    }

    // Inicializa ou limpa contagem se passou 1 minuto
    if (!this.requestCounts[uid] || now - this.requestCounts[uid].startTime > 60000) {
      this.requestCounts[uid] = { count: 1, startTime: now };
      return true;
    }

    // Incrementa contagem
    this.requestCounts[uid].count++;

    // Verifica se excedeu
    if (this.requestCounts[uid].count > RATE_LIMIT_CONFIG.maxRequestsPerMinute) {
      this.blockedUsers[uid] = now + RATE_LIMIT_CONFIG.blockDurationMs;
      this.showSecurityWarning();
      return false;
    }

    return true;
  }

  showSecurityWarning() {
    const existing = document.getElementById('security-alert');
    if (existing) return;

    const alert = document.createElement('div');
    alert.id = 'security-alert';
    alert.style = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: #ef4444; color: white; padding: 1rem 2rem;
      border-radius: 12px; font-weight: 600; z-index: 10000;
      box-shadow: 0 10px 30px rgba(239, 68, 68, 0.4);
      animation: slideDown 0.3s ease-out;
    `;
    alert.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px">
        <span>⚠️ Atividade suspeita detectada. Aguarde 1 minuto.</span>
      </div>
    `;
    document.body.appendChild(alert);

    setTimeout(() => alert.remove(), 5000);
  }
}

export const orbitaLimiter = new RateLimiter();

/**
 * Sanitização básica de HTML para prevenir XSS no editor Rich Text.
 * Permite apenas tags seguras e remove todos os atributos.
 */
export function sanitizeHTML(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const allowedTags = ['B', 'STRONG', 'U', 'I', 'EM', 'UL', 'LI', 'BR', 'DIV', 'SPAN', 'P'];
  
  function clean(node) {
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const child = node.childNodes[i];
      if (child.nodeType === 1) { // Elemento
        if (!allowedTags.includes(child.tagName)) {
          const text = document.createTextNode(child.textContent);
          node.replaceChild(text, child);
        } else {
          // Remove TODOS os atributos (segurança contra onclick, etc)
          while (child.attributes.length > 0) {
            child.removeAttribute(child.attributes[0].name);
          }
          clean(child);
        }
      } else if (child.nodeType !== 3) {
        node.removeChild(child);
      }
    }
  }

  clean(doc.body);
  return doc.body.innerHTML;
}

/**
 * Escapa caracteres HTML para exibição segura de texto puro.
 */
export function escapeHTML(str) {
  if (!str) return "";
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Wrapper de segurança para funções assíncronas do Firebase
 */
export async function secureAction(uid, actionFn) {
  if (!orbitaLimiter.checkLimit(uid)) {
    throw new Error("Rate limit exceeded. Please wait.");
  }
  return await actionFn();
}

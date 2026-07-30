#!/usr/bin/env python3
"""Servidor estático local pra desenvolvimento (uso pessoal, nao faz parte do deploy).
Serve arquivos como estao, e se o caminho pedido nao existir tenta path + ".html"
diretamente (sem redirect) -- assim URLs "limpas" (sem .html) funcionam e query
strings (?paciente=X) nunca se perdem, ao contrario do pacote "serve" do npm.
"""
import http.server
import os

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Remove query string antes de resolver o arquivo (SimpleHTTPRequestHandler
        # ja faz isso por baixo dos panos, mas replicamos aqui pra checar existencia)
        full_path = super().translate_path(path)
        if not os.path.exists(full_path) and not full_path.endswith('.html'):
            with_html = full_path + '.html'
            if os.path.exists(with_html):
                return with_html
        return full_path

    def end_headers(self):
        # Sem isso o navegador guarda em cache o .js/.css antigo quando o
        # DevTools esta fechado (com DevTools aberto o cache fica desativado
        # por padrao, mascarando o problema durante os testes).
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

if __name__ == '__main__':
    http.server.test(HandlerClass=Handler, port=5000)

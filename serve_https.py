#!/usr/bin/env python3
"""Petit serveur HTTPS local pour tester le « Mode caméra » sur iPhone (caméra + capteurs exigent HTTPS).

Usage :  python3 serve_https.py [port]      (défaut 8443)
- Génère un certificat auto-signé (cert.pem / key.pem) avec openssl s'il n'existe pas.
- Sert ce dossier sur https://<IP-du-PC>:8443/ à tout le réseau local (Wi-Fi).
- Sur l'iPhone (même Wi-Fi) : ouvrir l'adresse affichée, puis « Afficher les détails » ›
  « visiter ce site web » pour accepter le certificat auto-signé.
Arrêt : Ctrl+C.
"""
import http.server, ssl, socket, subprocess, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
if not (os.path.exists('cert.pem') and os.path.exists('key.pem')):
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem',
                    '-days', '365', '-subj', '/CN=celeste.local'], check=True)
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); ip = s.getsockname()[0]; s.close()
except OSError:
    ip = '127.0.0.1'
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.webmanifest': 'application/manifest+json', '.js': 'text/javascript'}
httpd = http.server.ThreadingHTTPServer(('0.0.0.0', port), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain('cert.pem', 'key.pem')
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print(f'Céleste en HTTPS : https://{ip}:{port}/  (et https://localhost:{port}/)')
httpd.serve_forever()

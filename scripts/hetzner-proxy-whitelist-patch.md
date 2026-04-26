# Hetzner Proxy — Tinglysning test-whitelist patch

**Server:** `204.168.164.252` (bizzassist-test.bizzassist.dk)
**Ticket:** BIZZ-887
**Dato:** 2026-04-24

## 🔬 Diagnose bekræftet 2026-04-24 (pass 2)

Kørte `node scripts/test-tinglysning-via-proxy.mjs` — aktuel state:

| Host                     | HTTP | Response body                                                          |
| ------------------------ | ---- | ---------------------------------------------------------------------- |
| `www.tinglysning.dk`     | 404  | `<html>...Siden findes ikke</html>` (Tinglysning selv — proxy forwarded) |
| `test.tinglysning.dk`    | 403  | `{"error":"Forbidden: test.tinglysning.dk is not whitelisted"}`        |
| `dss.tinglysning.dk`     | 403  | `{"error":"Forbidden: dss.tinglysning.dk is not whitelisted"}`         |

**→ Proxyen er Node/Express** (JSON-response format, ikke Caddy plaintext). Gå direkte
til sektion "Hvis proxyen er Node/Express" nedenfor — skipper Caddy-spor.

## Opgave
Tilføj 4-6 nye hostnames til proxy-allowlisten så Tinglysning testmiljøer kan nås.

## Hvis proxyen er Caddy (⚠️ IKKE aktuelt — se diagnose ovenfor)

### 1. SSH til serveren
```bash
ssh root@204.168.164.252
```

### 2. Find nuværende whitelist
```bash
# Prøv disse i rækkefølge:
grep -rE "tinglysning\.dk|whitelist|allowlist" /etc/caddy/
cat /etc/caddy/Caddyfile
# Eller hvis det er en Node/Express-proxy:
find /opt /srv /home -name "*.js" -newer /etc/passwd 2>/dev/null | head
systemctl status caddy
```

### 3. Forventet nuværende matcher (Caddyfile)
```caddy
@allowed {
    path_regexp ^/proxy/(www\.tinglysning\.dk|services\.datafordeler\.dk|graphql\.datafordeler\.dk|selfservice\.datafordeler\.dk)/.*
}
```

### 4. Tilføj nye hostnames
```caddy
@allowed {
    path_regexp ^/proxy/(www\.tinglysning\.dk|test\.tinglysning\.dk|dss\.tinglysning\.dk|test-xml-api\.tinglysning\.dk|dss-xml-api\.tinglysning\.dk|test-rest-api\.tinglysning\.dk|dss-rest-api\.tinglysning\.dk|services\.datafordeler\.dk|graphql\.datafordeler\.dk|selfservice\.datafordeler\.dk)/.*
}
```

### 5. Reload Caddy
```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### 6. Verifikér
Fra lokal maskine (eller BizzAssist-sandboxen):
```bash
cd /root/BizzAssist
node scripts/test-tinglysning-via-proxy.mjs
```

Forventet:
- Prod: 404/200 (ikke 403-fra-proxy)
- test.tinglysning.dk: 200 eller 4xx fra Tinglysning (ikke "is not whitelisted")
- dss.tinglysning.dk: samme

## Hvis proxyen er Node/Express (✅ dette er scenariet)

### 1. SSH til serveren
```bash
ssh root@204.168.164.252
```

### 2. Find config-filen via error-message-grep
```bash
grep -rln "is not whitelisted" /opt /srv /usr/local /home /root 2>/dev/null
# Forventet output: en .js eller .mjs fil
```

### 3. Aktuel whitelist (skal udvides)
Whitelist'en indeholder sandsynligvis en array af den form:
```js
const ALLOWED_HOSTS = [
  'www.tinglysning.dk',
  'services.datafordeler.dk',
  'graphql.datafordeler.dk',
  'selfservice.datafordeler.dk',
];
```

### 4. Tilføj disse 6 hostnames
```js
const ALLOWED_HOSTS = [
  'www.tinglysning.dk',
  // BIZZ-887: Tinglysning test- og hotfix-miljøer (2026-04-24)
  'test.tinglysning.dk',
  'dss.tinglysning.dk',
  'test-xml-api.tinglysning.dk',
  'dss-xml-api.tinglysning.dk',
  'test-rest-api.tinglysning.dk',     // aktiveres 2026-05-01
  'dss-rest-api.tinglysning.dk',      // aktiveres 2026-07-07
  'services.datafordeler.dk',
  'graphql.datafordeler.dk',
  'selfservice.datafordeler.dk',
];
```

### 5. Restart proxy
```bash
# Prøv disse i rækkefølge — afhængigt af hvordan proxyen er opsat:
systemctl list-units | grep -iE "proxy|bizz"
systemctl restart bizz-proxy      # mest sandsynligt
# eller hvis pm2:
pm2 list
pm2 restart all
```

### 6. Verifikér fra sandboxen (eller lokalt)
```bash
cd /root/BizzAssist
node scripts/test-tinglysning-via-proxy.mjs
```

Forventet efter patch:
| Host | HTTP forventet |
|---|---|
| `www.tinglysning.dk` | 200/404 (Tinglysning-response, ikke proxy-403) |
| `test.tinglysning.dk` | 200/4xx (Tinglysning-response, IKKE "is not whitelisted") |
| `dss.tinglysning.dk` | 200/4xx (Tinglysning-response, IKKE "is not whitelisted") |

## Alternativ: giv Claude SSH-adgang

Hvis du vil have mig til at lave ændringen direkte fremover, tilføj min pubkey til `/root/.ssh/authorized_keys` på serveren:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMwqQHtbXQvdfpvlybE80BqX95V2Hq95OPhvq11vhTlO claude-on-bizzassist-dev-primary
```

Så kan jeg SSH'e ind, finde config'en selv og applicere ændringen.

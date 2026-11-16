# VLK Service

Service- en kalibratie-app voor de Vlakkelichtkoepel besturing (RevB) van IMeTech Engineering.
Draait in de browser (Chrome op Android of op een pc met Bluetooth), installeerbaar als app en
bruikbaar zonder internet.

**Openen:** https://imetech-engineering.github.io/vlk-service-app/ (na publicatie)

## Wat kan het

- Live motorstroom als grafiek, bedienen (ook vasthouden/dodemans), elke rit als opname bewaren
- Eindherkenning kalibreren: 2x open en 2x dicht rijden, bevestigen, klaar
- Instellingen, afstandsbedieningen en Shelly-gateway koppelen, foutlog, tellers, duurtest
- Firmware-update via Bluetooth (alleen door IMeTech ondertekende firmware)
- Demo-stand zonder print

## Verbinden

1. Servicetoets op de print indrukken (servicevenster, 5 min, 2 piepjes).
2. In de app **Verbinden**, kies `VLK-xxxxxx` (naam staat op het label).
3. Pincode van het label invullen bij het koppelen.

## Veiligheid en privacy

- De app is een statische pagina: geen server, geen account, geen tracking, geen externe code.
  Er gaat niets naar internet; alles blijft tussen de telefoon en de print.
- Alle controles en veiligheidsregels zitten in de print zelf. De app kan ze niet omzeilen.
- Verbinden kan alleen fysiek bij de print (servicetoets) en met de unieke pincode van die print.
- Details: `docs/beveiliging.md` in de firmware-repo (op aanvraag bij IMeTech).

Een beveiligingsprobleem gevonden? Zie [SECURITY.md](SECURITY.md).

## Ontwikkelen

Geen build nodig: gewone HTML/CSS/JS-modules. Lokaal testen met `python -m http.server` en
`http://localhost:8000` (Web Bluetooth werkt op localhost en https).

- `js/endstop.js` moet 1-op-1 gelijk blijven aan `firmware/src/endstop.c`; test met
  `tools/es_replay_node.mjs` en de replaytest in de firmware-repo.
- Bij elke release het versienummer in `sw.js` ophogen (anders blijft de oude versie in de cache).

IMeTech Engineering, Aalten

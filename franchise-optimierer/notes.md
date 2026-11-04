# Notes – Franchise-Optimierer (KVG Schweiz)

## Ziel
Web-Tool, das für gegebene Prämien und erwartete Gesundheitskosten die günstigste
Franchise (CHF 300–2500, Erwachsene) findet und visualisiert.

## Recherche / Regeln (KVG/KVV)
- Ordentliche Franchise Erwachsene: CHF 300; wählbar 500, 1000, 1500, 2000, 2500.
- Nach Ausschöpfen der Franchise: Selbstbehalt 10 % (KK zahlt 90 %),
  Selbstbehalt gedeckelt bei CHF 700/Jahr (Erwachsene; Kinder CHF 350).
  -> Die Vorgabe "KK zahlt 90 %" stimmt, aber ohne Deckel würde das Tool bei hohen
  Kosten falsch rechnen. Deckel ist im Tool einstellbar (0 = kein Deckel).
- Prämienrabatt für wählbare Franchise: max. 70 % des zusätzlich übernommenen
  Risikos (F − 300) pro Jahr (Art. 95 Abs. 2bis KVV). Wird im Tool als optionale
  Schätzhilfe genutzt, wenn man nur die Prämie bei CHF 300 kennt.
- Nicht modelliert: Spitalbeitrag CHF 15/Tag, Mutterschaft (befreit), Unfall.

## Formel
c = über KK abgerechnete Kosten im Jahr
Kostenbeteiligung(F) = min(c, F) + min(0.1 · max(0, c − F), Deckel)
Total(F) = 12 · Prämie(F) + Kostenbeteiligung(F) + nicht gedeckte Kosten

## Umsetzung
- Single-file HTML/vanilla JS, keine Abhängigkeiten, SVG-Chart von Hand.
- Optimierung: alle 6 Stufen direkt berechnen (trivial); zusätzlich Sweep über
  c = 0 … Xmax in CHF-1-Schritten -> Bereiche, in denen welche Franchise optimal ist
  (Break-even-Punkte), als Farbband unter dem Chart.
- Farben: kategoriale Palette (dataviz-Skill, Slots 1–6, adjazent validiert), in
  fester Franchise-Reihenfolge.
- Eingaben werden in localStorage gemerkt (try/catch).
- Zahlenformat de-CH (Apostroph-Tausendertrenner), Eingaben akzeptieren 206.40,
  206,40 und 1'000.

## Test
- Playwright (Desktop 1280 px hell, Phone 390 px dunkel): keine Konsolenfehler, kein horizontales Scrollen.
- Beispiel 15 × 206.40 + 3 × 120 = CHF 3'456: Handrechnung CHF 300 → 5'040 + 300 + 315.60 = 5'655.60 = Tool-Ausgabe.
- Chart war auf dem Handy zu klein (viewBox fix 760 px) → viewBox-Breite folgt nun dem Container, neu zeichnen bei Resize.
- Tabellenbalken zeigten zuerst das Total ab 0 → Unterschiede kaum sichtbar; jetzt Balken = Mehrkosten zum Optimum.

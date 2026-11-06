# Arda Güler Gol & Asist Bildirimi (PWA)

Arda Güler gol veya asist yaptığında bildirim gönderen, ana ekrana eklenebilen web uygulaması.

## Nasıl çalışır

- **Uygulama (PWA)** – `index.html`, `app.js`, `sw.js`. ESPN canlı skor API'sinden Real Madrid (id 86) ve Türkiye (id 465) maçlarını bulur, canlı maçta 40 saniyede bir `keyEvents` listesini tarar. Gol atan (`participants[0]`) veya asist yapan (`participants[1]`) Arda Güler (id 310452) ise bildirim gösterir. Görülen olaylar `localStorage` içinde tutulur, tekrar bildirilmez.
- **Bot** – `bot/check.py`, GitHub Actions ile 5 dakikada bir çalışır (`.github/workflows/check.yml`). Canlı maç varsa ~4.5 dk boyunca 30 saniyede bir tarar ve yeni olayı [ntfy](https://ntfy.sh) kanalına gönderir. Böylece uygulama kapalıyken de telefona bildirim gelir. Görülen olaylar `state/seen.json` dosyasına commit edilir.

ntfy kanalı: `arda-guler-gol-mmk34`

## Kurulum (telefon)

1. Siteyi aç, **İzin ver** ile bildirim iznini ver.
2. Android: **Yükle** → ana ekrana ekle. iPhone: Safari → Paylaş → Ana Ekrana Ekle (iOS'ta bildirim sadece ana ekrandaki uygulamada çalışır).
3. Uygulama kapalıyken de bildirim için ntfy uygulamasını kur ve `arda-guler-gol-mmk34` kanalına abone ol.

## Notlar

- Veri kaynağı ESPN'in halka açık skor uç noktalarıdır; gecikme genelde 30–90 saniyedir.
- GitHub zamanlanmış iş akışları 60 gün repo etkinliği olmazsa durur; `state/seen.json` commit'leri bunu çoğu zaman tazeler. Durursa Actions sekmesinden tekrar etkinleştir.

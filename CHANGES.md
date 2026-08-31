# Is update mein kya kya add/change hua (React Native app)

## Naye dependencies (package.json)
- `react-native-svg` — card artwork aur field icons ke liye
- `expo-linear-gradient` — blue gradient cards, premium bottom nav,
  aur "Ohm" badge ke liye

## Nayi files (src/)
- `src/artwork.js` — original line-art illustrations (CardArt: ohm,
  amp, top, cable, dmx), chhote FieldIcon (qty, impedance, power,
  connection, lfSpeaker, hfDriver, channels, fixtures, address,
  length), aur EqualizerArt (brand ke peeche waala frequency-bar art).
  Koi bhi real product photo nahi — sab hand-drawn shapes hain.
- `src/Btn.js` — TouchableOpacity ka drop-in replacement jisme subtle
  premium press animation (scale + spring) built-in hai. Poore App.js
  mein har TouchableOpacity ko isse replace kiya gaya hai, taaki har
  button/card pe tap karne par animation ho.
- `src/PopText.js` — number "pop-in" animation wala Text component.
  Result numbers (Ohm load, Amp Ω, DMX address, stepper count) par
  laga hai — jab value change hoti hai to halka scale+fade animation
  chalta hai.

## App.js mein changes
1. **Home screen cards** — ab LinearGradient background (flat color
   ki jagah) + peeche CardArt illustration (30% opacity, poora card
   cover karta hai): Ohm→speaker driver, Amp→amp rack, Top→dual
   cabinets, Cable→coiled cable+connector, DMX→moving-head light.
2. **"AmpOhm" wordmark** — "Ohm" ab ek solid gradient badge hai (View,
   text nahi) taaki kisi bhi device pe invisible na ho. Peeche ek
   subtle equalizer-bars artwork hai (sirf is hero block ke peeche,
   poore screen pe nahi).
3. **Calculator headers** — Ohm/Amp/Top/DMX/Cable ka Header ab ek
   halke bordered/tinted card ke andar hai (home cards jaisi hi
   language, bas bahut low opacity mein).
4. **Field labels** — kuch fields ab ek chhota related icon ke saath
   dikhte hain (jaise LF Speaker fields ke saath speaker icon, HF
   Driver ke saath horn icon).
5. **Bottom nav** — ab ek floating rounded card hai apni shadow ke
   saath; active tab (Home/Info) ko gradient pill highlight milta hai.
6. **Press animation** — sab buttons/cards par ab tap karne se subtle
   scale-down + spring-back hota hai (Btn.js).
7. **Number animation** — stepper count, Ohm/Amp ka result number, aur
   DMX address har change par halka pop-in animation dikhate hain.

## Jaan-boojh kar NAHI kiya
- Koi real product photo/branded imagery use nahi ki — sab original
  SVG illustrations hain (copyright-safe).
- Phone "notch" chrome sirf HTML preview ka mockup tha (browser mein
  phone-frame dikhane ke liye) — real device pe ye apply nahi hota,
  isliye App.js mein iska koi equivalent nahi hai.

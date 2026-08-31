import React, { useState, useEffect, useCallback, useMemo, useContext, createContext } from "react";
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  StyleSheet,
  StatusBar,
  Linking,
  Share,
  ActivityIndicator,
  BackHandler,
} from "react-native";
import { T, PLATE_RATINGS, CABLE_SIZES, COPPER_RESISTIVITY, CCA_RESISTIVITY } from "./src/translations";
import { Storage } from "./src/storage";
import { LinearGradient } from "expo-linear-gradient";
import Btn from "./src/Btn";
import PopText from "./src/PopText";
import { CardPhoto, FieldIcon, EqualizerArt } from "./src/artwork";
import mobileAds, {
  BannerAd,
  BannerAdSize,
  RewardedAd,
  RewardedAdEventType,
  AdEventType,
} from "react-native-google-mobile-ads";
import { AD_UNIT_IDS } from "./src/ads";

// Fires and loads a rewarded ad, calling onEarned() only when the
// person actually watches it through (the "earned reward" event) —
// never on a plain skip/close. Creates a fresh instance per call,
// which is simplest for now; preloading ahead of time is a later
// optimization once this is confirmed working end-to-end.
function playRewardedAd(onEarned, onFail) {
  const rewarded = RewardedAd.createForAdRequest(AD_UNIT_IDS.rewarded);
  let earned = false;

  const unsubEarned = rewarded.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
    earned = true;
    onEarned();
  });
  const unsubLoaded = rewarded.addAdEventListener(AdEventType.LOADED, () => {
    rewarded.show();
  });
  const unsubError = rewarded.addAdEventListener(AdEventType.ERROR, (error) => {
    console.warn("Rewarded ad failed to load:", error);
    if (onFail) onFail();
    unsubEarned();
    unsubLoaded();
    unsubError();
    unsubClosed();
  });
  const unsubClosed = rewarded.addAdEventListener(AdEventType.CLOSED, () => {
    if (!earned && onFail) onFail();
    unsubEarned();
    unsubLoaded();
    unsubError();
    unsubClosed();
  });

  rewarded.load();
}

// =====================================================================
// COLORS — mirrors the web app's CSS custom properties (style.css).
// `C` is reassigned at the top of the App component's render based on
// the active theme (see below), and `styles` is rebuilt from it via
// buildStyles(). Because StyleSheet.create() bakes its values in at
// call time (unlike a CSS string, it's a plain JS object computed
// once), styles can't just read a mutated C automatically the way the
// web preview's <style> template literal does — buildStyles(C) has to
// be re-run whenever the theme changes, and the shared `styles`
// binding reassigned to that fresh result.
// =====================================================================
const LIGHT_C = {
  bg: "#f3f6fc",
  card: "#ffffff",
  cardSoft: "rgba(255,255,255,0.7)",
  soft: "#f8fafc",
  border: "#e3e8f2",
  amber: "#2563eb",
  amberDark: "#1d4ed8",
  green: "#16a34a",
  red: "#dc2626",
  text: "#0b1220",
  muted: "#64748b",
};
const DARK_C = {
  bg: "#0b1220",
  card: "#151d2e",
  cardSoft: "rgba(21,29,46,0.7)",
  soft: "#1a2338",
  border: "rgba(255,255,255,0.10)",
  amber: "#3b82f6",
  amberDark: "#2563eb",
  green: "#22c55e",
  red: "#f87171",
  text: "#f1f5f9",
  muted: "#94a3b8",
};
let C = LIGHT_C;

// Provides { C, styles } to the standalone helper components below
// (Header, InfoBox, ActionRow, etc.) that live outside the App
// component's closure, so they re-render with the right theme too.
const ThemeContext = createContext({ C: LIGHT_C, styles: null });

const IMPEDANCE_OPTIONS = [2, 4, 6, 8, 16];

// Play Store link used in the branded share-result footer. Swap for
// the App Store link too once iOS is live (e.g. pick by Platform.OS).
const APP_SHARE_LINK = "https://play.google.com/store/apps/details?id=com.audioxpert.ampohm";

// =====================================================================
// CALCULATORS — pure functions, no UI. Same formulas as the web app's
// app.js (calcOhm/calcAmp/calcTop) — keep both in sync if either changes.
// =====================================================================
function getLoadStatus(total, t) {
  if (total < 2) return { type: "danger", msg: t.safeDanger };
  if (total < 4) return { type: "warn", msg: t.safeWarn };
  if (total > 16) return { type: "warn", msg: t.safeHigh };
  return { type: "good", msg: t.safeGood };
}
// Picks one contextual, load-specific tip instead of a static block of
// text — what's useful to know changes with how low/high the load is.
function getOhmTip(total, t) {
  if (total < 1) return t.ohmTipExtreme;
  if (total < 2) return t.ohmTipLow;
  if (total <= 8) return t.ohmTipSweet;
  if (total <= 16) return t.ohmTipHigh;
  return t.ohmTipVeryHigh;
}

function calcOhmResult(impedance, qty, conn) {
  const total =
    conn === "parallel"
      ? Math.round((impedance / qty) * 100) / 100
      : impedance * qty;
  return { total };
}

function calcAmpResult(rms, qty, impedance, conn) {
  const finalLoad =
    conn === "series"
      ? impedance * qty
      : Math.round((impedance / qty) * 100) / 100;
  const totalRms = rms * qty;
  return {
    finalLoad,
    min: Math.round(totalRms),
    ideal: Math.round(totalRms * 1.5),
    max: Math.round(totalRms * 2),
  };
}

function calcTopResult(lf1Watt, lf2Watt, hfWatt) {
  // Fixed cabinet config: 1 top = 2 LF + 1 HF (no quantity input).
  const cabinetPower = lf1Watt + lf2Watt + hfWatt;
  const target = cabinetPower * 1.2;
  const plate = PLATE_RATINGS.find((p) => p >= target) || null;
  return {
    lf1Watt,
    lf2Watt,
    hfWatt,
    cabinetPower,
    plate,
    min: Math.round(cabinetPower),
    ideal: Math.round(cabinetPower * 1.5),
    max: Math.round(cabinetPower * 2),
  };
}

// DMX Address Calculator: each fixture's start address is offset from
// the previous one by "channels per fixture". Flags the setup if it
// runs past the 512-channel DMX universe limit.
function calcDmxResult(channels, fixtures, startAddr) {
  const addresses = [];
  for (let i = 0; i < fixtures; i++) {
    addresses.push(startAddr + i * channels);
  }
  const lastEnd = startAddr + fixtures * channels - 1;
  return { addresses, overLimit: lastEnd > 512, lastEnd };
}

// Speaker Cable Loss Calculator: models the cable as a series
// resistance in a voltage divider with the speaker's nominal
// impedance. dB loss = 20·log10(Z / (Z + Rcable)); Rcable is the
// round-trip resistance for a given copper cross-section. Status
// tiers are a practical rule of thumb, not a hard spec.
function calcCableResult(power, impedance, length, resistivity) {
  const results = CABLE_SIZES.map((size) => {
    const rCable = (2 * length * resistivity) / size;
    const dB = Math.abs(10 * Math.log10(impedance / (impedance + rCable)));
    let statusKey, emoji;
    if (dB < 0.5) { statusKey = "statusExcellent"; emoji = "🟢"; }
    else if (dB < 1.5) { statusKey = "statusGood"; emoji = "🟢"; }
    else if (dB < 3) { statusKey = "statusAcceptable"; emoji = "🟡"; }
    else { statusKey = "statusHighLoss"; emoji = "🔴"; }
    return { size, dB, statusKey, emoji };
  });

  const recommended =
    results.find((r) => r.statusKey === "statusExcellent" || r.statusKey === "statusGood") ||
    results.reduce((best, r) => (r.dB < best.dB ? r : best));
  // "Best" = smallest cable that reaches the "Excellent" tier — not
  // just literally the lowest-loss cable, which is trivially always
  // the thickest one (6mm²) regardless of how little power is used.
  const best =
    results.find((r) => r.statusKey === "statusExcellent") ||
    results.reduce((b, r) => (r.dB < b.dB ? r : b));
  const current = Math.round(Math.sqrt(power / impedance) * 100) / 100;

  return { results, recommended, best, current };
}

const statusColor = (type) =>
  type === "good" ? C.green : type === "danger" ? C.red : "#fcd34d";

// =====================================================================
// SHARED UI PIECES
// =====================================================================
function LangToggle({ lang, setLang }) {
  const { styles } = useContext(ThemeContext);
  return (
    <View style={styles.langWrap}>
      <Btn
        onPress={() => setLang("en")}
        style={[styles.langBtn, lang === "en" && styles.langBtnActive]}
      >
        <Text style={[styles.langBtnText, lang === "en" && styles.langBtnTextActive]}>English</Text>
      </Btn>
      <Btn
        onPress={() => setLang("hi")}
        style={[styles.langBtn, lang === "hi" && styles.langBtnActive]}
      >
        <Text style={[styles.langBtnText, lang === "hi" && styles.langBtnTextActive]}>हिंदी</Text>
      </Btn>
    </View>
  );
}

function Header({ title, sub, onBack }) {
  const { C, styles } = useContext(ThemeContext);
  return (
    <View style={styles.headerRow}>
      <Btn style={styles.backBtn} onPress={onBack}>
        <Text style={{ color: C.text, fontSize: 18 }}>‹</Text>
      </Btn>
      <View>
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.headerSub}>{sub}</Text>
      </View>
    </View>
  );
}

// step is optional so every existing caller (Ohm/Amp qty, DMX
// fixtures) keeps incrementing by 1 as before. Only Top Speaker's LF
// count passes step={2} explicitly (2 LF per cabinet) — this shared
// component's default behavior is unchanged for everyone else.
function Stepper({ value, onChange, min = 1, max = 20, step = 1 }) {
  const { styles } = useContext(ThemeContext);
  return (
    <View style={styles.stepper}>
      <Btn style={styles.stepperBtn} onPress={() => onChange(Math.max(min, value - step))}>
        <Text style={styles.stepperBtnText}>−</Text>
      </Btn>
      <PopText value={value} style={styles.stepperVal}>{value}</PopText>
      <Btn style={styles.stepperBtn} onPress={() => onChange(Math.min(max, value + step))}>
        <Text style={styles.stepperBtnText}>+</Text>
      </Btn>
    </View>
  );
}

// Field label with a small related icon (speaker, impedance, power,
// etc.) instead of plain text — same visual language as the home
// screen cards, scaled down and single-color.
function FieldLabelRow({ icon, label }) {
  const { styles } = useContext(ThemeContext);
  return (
    <View style={styles.fieldLabelRow}>
      <FieldIcon type={icon} />
      <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>{label}</Text>
    </View>
  );
}

function ImpedanceChips({ value, onChange }) {
  const { styles } = useContext(ThemeContext);
  return (
    <View style={styles.chipsRow}>
      {IMPEDANCE_OPTIONS.map((imp) => (
        <Btn
          key={imp}
          style={[styles.chip, value === imp && styles.chipActive]}
          onPress={() => onChange(imp)}
        >
          <Text style={[styles.chipText, value === imp && styles.chipTextActive]}>{imp}Ω</Text>
        </Btn>
      ))}
    </View>
  );
}

function ConnToggle({ value, onChange, t }) {
  const { styles } = useContext(ThemeContext);
  return (
    <View style={styles.connGrid}>
      <Btn
        style={[styles.connBtn, value === "parallel" && styles.connBtnActive]}
        onPress={() => onChange("parallel")}
      >
        <Text style={styles.connGlyph}>⧉⧉</Text>
        <Text style={[styles.connText, value === "parallel" && styles.connTextActive]}>{t.parallel}</Text>
      </Btn>
      <Btn
        style={[styles.connBtn, value === "series" && styles.connBtnActive]}
        onPress={() => onChange("series")}
      >
        <Text style={styles.connGlyph}>⊢⊣⊢⊣</Text>
        <Text style={[styles.connText, value === "series" && styles.connTextActive]}>{t.series}</Text>
      </Btn>
    </View>
  );
}

function StatusPill({ type, msg }) {
  const { styles } = useContext(ThemeContext);
  const color = statusColor(type);
  return (
    <View style={[styles.statusPill, { borderColor: color, backgroundColor: color + "1a" }]}>
      <Text style={[styles.statusPillText, { color }]}>
        {type === "good" ? "✓ " : "⚠ "}
        {msg}
      </Text>
    </View>
  );
}

// Premium floating pill nav — active tab gets a gradient pill with its
// own shadow instead of a flat tint, matching the web preview's nav.
function BottomNav({ screen, setScreen, t }) {
  const { C, styles } = useContext(ThemeContext);
  const NavItem = ({ active, icon, label, onPress }) => (
    <Btn style={styles.navItem} onPress={onPress}>
      {active ? (
        <LinearGradient colors={[C.amber, C.amberDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.navItemActiveFill}>
          <Text style={styles.navIcon}>{icon}</Text>
          <Text style={[styles.navItemText, { color: "#ffffff" }]}>{label}</Text>
        </LinearGradient>
      ) : (
        <View style={styles.navItemInner}>
          <Text style={styles.navIcon}>{icon}</Text>
          <Text style={styles.navItemText}>{label}</Text>
        </View>
      )}
    </Btn>
  );
  return (
    <View style={styles.bottomNav}>
      <NavItem active={screen === "home"} icon="🏠" label={t.homeNav} onPress={() => setScreen("home")} />
      <NavItem active={screen === "info"} icon="ℹ️" label={t.infoNav} onPress={() => setScreen("info")} />
    </View>
  );
}

function InfoBox({ title, children, amber }) {
  const { C, styles } = useContext(ThemeContext);
  return (
    <View style={[styles.infoBox, amber && styles.infoBoxAmber]}>
      {title ? <Text style={[styles.infoBoxTitle, amber && { color: C.amber }]}>{title}</Text> : null}
      <Text style={styles.infoBoxText}>{children}</Text>
    </View>
  );
}

// Wraps a calculator's result lines in the shared branded header/footer
// used by every "Share" button — keeps the format identical across
// all five calculators and in one place to update.
function buildShareText(t, bodyLines) {
  return [
    t.shareHeader,
    "",
    ...bodyLines,
    "",
    t.shareFooterLine1,
    t.shareFooterLine2,
    "",
    t.shareDownloadLabel,
    APP_SHARE_LINK,
  ].join("\n");
}

function ActionRow({ onReset, t, shareText }) {
  const { styles } = useContext(ThemeContext);
  const onShare = () => {
    Share.share({ message: shareText || "AmpOhm" }).catch(() => {
      // user cancelled the share sheet — not an error, do nothing
    });
  };
  return (
    <View style={styles.actionRow}>
      <Btn style={styles.actionBtn} onPress={onReset}>
        <Text style={styles.actionBtnText}>↺ {t.reset}</Text>
      </Btn>
      <Btn style={styles.actionBtn} onPress={onShare}>
        <Text style={styles.actionBtnText}>⇪ {t.share}</Text>
      </Btn>
    </View>
  );
}

// AdUnlockGate — shown in place of a calculator's result until the
// person watches a rewarded ad. `onWatch` should trigger the real
// rewarded-ad SDK (e.g. AdMob RewardedAd.show()) and, on the ad's
// "earned reward" callback, flip the relevant *AdUnlocked state to
// true. This component only renders the UI + loading state; wire the
// actual ad network call into onWatch.
function AdUnlockGate({ loading, error, onWatch, t }) {
  const { C, styles } = useContext(ThemeContext);
  return (
    <LinearGradient
      colors={["#fde9b0", "#d4a017", "#f5d78e"]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.adGateBorder}
    >
      <LinearGradient colors={[C.amber, C.amberDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.adGate}>
        <Text style={styles.adGateIcon}>🎬</Text>
        <Text style={styles.adGateTitle}>{t.adUnlockTitle}</Text>
        <Text style={styles.adGateSub}>{t.adUnlockSub}</Text>
        <Btn style={styles.adGateBtn} onPress={onWatch} disabled={loading}>
          {loading ? (
            <ActivityIndicator size="small" color={C.amberDark} />
          ) : (
            <Text style={styles.adGateBtnText}>{t.watchAdBtn}</Text>
          )}
        </Btn>
        {error ? <Text style={styles.adGateError}>{t.adFailedText}</Text> : null}
      </LinearGradient>
    </LinearGradient>
  );
}

// =====================================================================
// APP
// =====================================================================
export default function App() {
  const [lang, setLangState] = useState("en"); // English by default; restored below if a preference was saved
  const [screen, setScreen] = useState("home");
  const t = T[lang];

  // ---- Theme (light/dark) ----
  const [theme, setThemeState] = useState("light"); // light by default; restored below if a preference was saved
  C = theme === "dark" ? DARK_C : LIGHT_C;
  const styles = useMemo(() => buildStyles(C), [theme]);
  const setTheme = useCallback((th) => {
    setThemeState(th);
    Storage.setTheme(th); // persist for next launch
  }, []);
  useEffect(() => {
    (async () => {
      const savedTheme = await Storage.getTheme();
      if (savedTheme) setThemeState(savedTheme);
    })();
  }, []);

  useEffect(() => {
    mobileAds()
      .initialize()
      .then(() => {})
      .catch((err) => console.warn("Mobile ads init failed:", err));
  }, []);

  // ---- Ohm Calculator state ----
  const [ohmQty, setOhmQty] = useState(2);
  const [ohmImpedance, setOhmImpedance] = useState(8);
  const [ohmConn, setOhmConn] = useState("parallel");
  const [ohmResult, setOhmResult] = useState(null);

  // ---- Amplifier Calculator state ----
  const [ampRms, setAmpRms] = useState("300");
  const [ampQty, setAmpQty] = useState(1);
  const [ampImpedance, setAmpImpedance] = useState(8);
  const [ampConn, setAmpConn] = useState("parallel");
  const [ampResult, setAmpResult] = useState(null);
  const [ampAdUnlocked, setAmpAdUnlocked] = useState(false);
  const [ampAdLoading, setAmpAdLoading] = useState(false);
  const [ampAdError, setAmpAdError] = useState(false);

  // ---- Top Speaker Calculator state ----
  const [topLf1Watt, setTopLf1Watt] = useState("400");
  const [topLf2Watt, setTopLf2Watt] = useState("400");
  const [topHfWatt, setTopHfWatt] = useState("100");
  const [topResult, setTopResult] = useState(null);
  const [topAdUnlocked, setTopAdUnlocked] = useState(false);
  const [topAdLoading, setTopAdLoading] = useState(false);
  const [topAdError, setTopAdError] = useState(false);

  // ---- DMX Address Calculator state ----
  const [dmxChannels, setDmxChannels] = useState("16");
  const [dmxFixtures, setDmxFixtures] = useState("4");
  const [dmxStart, setDmxStart] = useState("1");
  const [dmxResult, setDmxResult] = useState(null);
  const [dmxError, setDmxError] = useState(false);
  const [dmxAdUnlocked, setDmxAdUnlocked] = useState(false);
  const [dmxAdLoading, setDmxAdLoading] = useState(false);
  const [dmxAdError, setDmxAdError] = useState(false);
  const [topError, setTopError] = useState(false);
  const [ampError, setAmpError] = useState(false);
  // Field-work progress tracker — which specific fixtures (by index) a
  // technician has physically addressed so far, tap-to-toggle any order.
  // Independent of the address list above.
  const [dmxFlags, setDmxFlags] = useState([]);

  // ---- Speaker Cable Loss Calculator state ----
  const [cablePower, setCablePower] = useState("500");
  const [cableQty, setCableQty] = useState(1);
  const [cableImpedance, setCableImpedance] = useState(8);
  const [cableConn, setCableConn] = useState("parallel");
  const [cableType, setCableType] = useState("copper");
  const [cableLength, setCableLength] = useState("20");
  const [cableResult, setCableResult] = useState(null);
  const [cableError, setCableError] = useState(false);

  // ---- Info screen state ----
  const [infoDetailIndex, setInfoDetailIndex] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Init: restore saved language preference
  useEffect(() => {
    (async () => {
      const saved = await Storage.getLanguage();
      if (saved) setLangState(saved);
    })();
  }, []);

  const setLang = useCallback((l) => {
    setLangState(l);
    Storage.setLanguage(l); // persist for next launch
  }, []);

  const goHome = (resetFn) => {
    if (resetFn) resetFn();
    setScreen("home");
  };

  // ---- Android hardware back button ----
  // Mirrors each screen's own back-arrow target so the physical back
  // button always steps up one level instead of closing the app.
  useEffect(() => {
    const onBackPress = () => {
      if (menuOpen) {
        setMenuOpen(false);
        return true;
      }
      switch (screen) {
        case "home":
          return false; // let the OS handle it (exits the app), same as any Android app's top level
        case "ohm":
          goHome(resetOhm);
          return true;
        case "amp":
          goHome(resetAmp);
          return true;
        case "top":
          goHome(resetTop);
          return true;
        case "dmx":
          goHome(resetDmx);
          return true;
        case "cable":
          goHome(resetCable);
          return true;
        case "info-detail":
        case "about":
        case "contact":
          setScreen("info");
          return true;
        case "info":
          setScreen("home");
          return true;
        default:
          setScreen("home");
          return true;
      }
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [screen, menuOpen]);

  // ---- Screen: HOME ----
  const renderHome = () => (
    <ScrollView contentContainerStyle={styles.screenPad}>
      <View style={styles.topBarRow}>
        <View style={styles.menuWrap}>
          <Btn style={styles.menuBtn} onPress={() => setMenuOpen(!menuOpen)}>
            <Text style={styles.menuBtnText}>☰</Text>
          </Btn>
          {menuOpen && (
            <View style={styles.menuDropdown}>
              <Btn
                style={styles.menuItem}
                onPress={() => {
                  setTheme(theme === "dark" ? "light" : "dark");
                  setMenuOpen(false);
                }}
              >
                <Text style={styles.menuItemText}>
                  {theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode"}
                </Text>
              </Btn>
            </View>
          )}
        </View>
        <Btn style={styles.topLangPill} onPress={() => setLang(lang === "hi" ? "en" : "hi")}>
          <Text style={styles.topLangPillText}>🌐 {lang === "hi" ? "हिंदी" : "EN"} ▾</Text>
        </Btn>
      </View>

      <View style={styles.brand}>
        <EqualizerArt style={styles.brandEq} />
        <View style={styles.brandLogoRow}>
          <View style={styles.brandLogoBox}>
            <Text style={styles.brandLogoGlyph}>⚡</Text>
          </View>
          {/* "Ohm" is a solid gradient badge (a real View), not a
              gradient-clipped text fill — that technique can render
              invisible on some devices. Note: LinearGradient can't be
              nested inside <Text>, so this is a row of two elements,
              not one text string. */}
          <View style={styles.brandTextRow}>
            <Text style={styles.brandText}>Amp</Text>
            <LinearGradient
              colors={[C.amber, C.amberDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.brandAccentBadge}
            >
              <Text style={styles.brandAccentText}>Ohm</Text>
            </LinearGradient>
          </View>
        </View>
        <Text style={styles.tagline}>{t.tagline}</Text>
        <View style={styles.trustRow}>
          <Text style={styles.trustItem}>⚡ Fast</Text>
          <Text style={styles.trustDivider}>│</Text>
          <Text style={styles.trustItem}>✦ Accurate</Text>
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <View style={styles.sectionBar} />
        <Text style={styles.sectionLabel}>{t.audioToolsLabel || "AUDIO TOOLS"}</Text>
      </View>

      <View style={styles.gridWrap}>
        <Btn style={styles.gridCard} onPress={() => setScreen("ohm")}>
          <LinearGradient colors={[C.amber, C.amberDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill} />
          <CardPhoto type="ohm" opacity={0.9} />
          <LinearGradient
            colors={[C.amberDark, "rgba(29,78,216,0.15)", "rgba(29,78,216,0)"]}
            locations={[0, 0.45, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fill}
            pointerEvents="none"
          />
          <View style={styles.gridCardIconBox}>
            <Text style={styles.gridCardIcon}>Ω</Text>
          </View>
          <Text style={styles.gridCardTitle}>{t.ohmTitle}</Text>
          <Text style={styles.gridCardSub}>{t.ohmSub}</Text>
          <View style={styles.gridChevron}>
            <Text style={styles.gridChevronText}>›</Text>
          </View>
        </Btn>

        <Btn style={styles.gridCard} onPress={() => setScreen("amp")}>
          <LinearGradient colors={[C.amber, C.amberDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill} />
          <CardPhoto type="amp" opacity={0.9} />
          <LinearGradient
            colors={[C.amberDark, "rgba(29,78,216,0.15)", "rgba(29,78,216,0)"]}
            locations={[0, 0.45, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fill}
            pointerEvents="none"
          />
          <View style={styles.gridCardIconBox}>
            <Text style={styles.gridCardIcon}>⚡</Text>
          </View>
          <Text style={styles.gridCardTitle}>{t.ampTitle}</Text>
          <Text style={styles.gridCardSub}>{t.ampSub}</Text>
          <View style={styles.gridChevron}>
            <Text style={styles.gridChevronText}>›</Text>
          </View>
        </Btn>

        <Btn style={styles.gridCard} onPress={() => setScreen("top")}>
          <LinearGradient colors={[C.amber, C.amberDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill} />
          <CardPhoto type="top" opacity={0.9} />
          <LinearGradient
            colors={[C.amberDark, "rgba(29,78,216,0.15)", "rgba(29,78,216,0)"]}
            locations={[0, 0.45, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fill}
            pointerEvents="none"
          />
          <View style={styles.gridCardIconBox}>
            <Text style={styles.gridCardIcon}>🔊</Text>
          </View>
          <Text style={styles.gridCardTitle}>{t.topTitle}</Text>
          <Text style={styles.gridCardSub}>{t.topSub}</Text>
          <View style={styles.gridChevron}>
            <Text style={styles.gridChevronText}>›</Text>
          </View>
        </Btn>

        <Btn style={styles.gridCard} onPress={() => setScreen("cable")}>
          <LinearGradient colors={[C.amber, C.amberDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill} />
          <CardPhoto type="cable" opacity={0.9} />
          <LinearGradient
            colors={[C.amberDark, "rgba(29,78,216,0.15)", "rgba(29,78,216,0)"]}
            locations={[0, 0.45, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fill}
            pointerEvents="none"
          />
          <View style={styles.gridCardIconBox}>
            <Text style={styles.gridCardIcon}>🎧</Text>
          </View>
          <Text style={styles.gridCardTitle}>{t.cableTitle}</Text>
          <Text style={styles.gridCardSub}>{t.cableSub}</Text>
          <View style={styles.gridChevron}>
            <Text style={styles.gridChevronText}>›</Text>
          </View>
        </Btn>
      </View>

      <View style={styles.sectionHeader}>
        <View style={styles.sectionBar} />
        <Text style={styles.sectionLabel}>{t.lightingToolsLabel || "LIGHTING TOOLS"}</Text>
      </View>

      <Btn style={styles.fullCard} onPress={() => setScreen("dmx")}>
        <LinearGradient colors={[C.amber, C.amberDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill} />
        <CardPhoto type="dmx" opacity={0.9} />
          <LinearGradient
            colors={[C.amberDark, "rgba(29,78,216,0.15)", "rgba(29,78,216,0)"]}
            locations={[0, 0.45, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fill}
            pointerEvents="none"
          />
        <View style={styles.gridCardIconBox}>
          <Text style={styles.gridCardIcon}>🤖</Text>
        </View>
        <View style={styles.fullCardBody}>
          <Text style={styles.gridCardTitle}>{t.dmxTitle}</Text>
          <Text style={styles.gridCardSub}>{t.dmxSub}</Text>
        </View>
        <View style={styles.gridChevron}>
          <Text style={styles.gridChevronText}>›</Text>
        </View>
      </Btn>

      <View style={styles.soonBox}>
        <Text style={styles.soonLabel}>{t.comingSoon}</Text>
        {t.comingList.map((c) => (
          <Text key={c} style={styles.soonItem}>{c}</Text>
        ))}
      </View>

      <BottomNav screen={screen} setScreen={setScreen} t={t} />
    </ScrollView>
  );

  // ---- Screen: OHM CALCULATOR ----
  const resetOhm = () => setOhmResult(null);
  const calcOhm = () => setOhmResult(calcOhmResult(ohmImpedance, ohmQty, ohmConn));

  const renderOhm = () => {
    const status = ohmResult ? getLoadStatus(ohmResult.total, t) : null;
    return (
      <ScrollView contentContainerStyle={styles.screenPad}>
        <View style={styles.calcHeaderCard}>
        <Header title={t.ohmTitle} sub={t.ohmSub} onBack={() => goHome(resetOhm)} />
      </View>
        <LangToggle lang={lang} setLang={setLang} />

        {!ohmResult ? (
          <View>
            <View style={styles.field}>
              <FieldLabelRow icon="qty" label={t.step1Ohm} />
              <Stepper value={ohmQty} onChange={setOhmQty} />
            </View>
            <View style={styles.field}>
              <FieldLabelRow icon="impedance" label={t.step2Ohm} />
              <ImpedanceChips value={ohmImpedance} onChange={setOhmImpedance} />
            </View>
            <View style={styles.field}>
              <FieldLabelRow icon="connection" label={t.step3Ohm} />
              <ConnToggle value={ohmConn} onChange={setOhmConn} t={t} />
            </View>
            <Btn style={styles.calcBtn} onPress={calcOhm}>
              <Text style={styles.calcBtnText}>{t.calculate}</Text>
            </Btn>
          </View>
        ) : (
          <View>
            <Text style={styles.resultTitle}>{t.resultTitle}</Text>
            <View style={styles.resultBox}>
              <Text style={styles.resultLbl}>{t.totalLoad}</Text>
              <PopText value={ohmResult.total} style={styles.resultBig}>{ohmResult.total}Ω</PopText>
              <StatusPill type={status.type} msg={status.msg} />
            </View>
            <InfoBox title={t.detailsTitle}>
              {ohmQty} × {ohmImpedance}Ω ({ohmConn === "parallel" ? t.parallel : t.series}){"\n"}{getOhmTip(ohmResult.total, t)}
            </InfoBox>
            <ActionRow
              onReset={resetOhm}
              t={t}
              shareText={buildShareText(t, [
                "🔢 " + t.step1Ohm.replace(/^\d+\.\s*/, "") + ": " + ohmQty,
                "🎚️ " + t.step2Ohm.replace(/^\d+\.\s*/, "") + ": " + ohmImpedance + "Ω",
                "🔌 " + t.shareConnLabel + ": " + (ohmConn === "parallel" ? t.parallel : t.series),
                "",
                "📊 " + t.totalLoad + ": " + ohmResult.total + "Ω",
              ])}
            />
          </View>
        )}
      </ScrollView>
    );
  };

  // ---- Screen: AMPLIFIER CALCULATOR ----
  const resetAmp = () => { setAmpResult(null); setAmpError(false); setAmpAdUnlocked(false); setAmpAdLoading(false); setAmpAdError(false); };
  const calcAmp = () => {
    if (Number(ampRms) <= 0 || ampRms === "") {
      setAmpError(true);
      return; // don't calculate until fixed
    }
    setAmpError(false);
    setAmpAdUnlocked(false);
    setAmpAdError(false);
    const rms = Number(ampRms) || 0;
    setAmpResult(calcAmpResult(rms, ampQty, ampImpedance, ampConn));
  };
  // Wire this to a real rewarded-ad SDK: call the ad network's "show"
  // method here, and only call setAmpAdUnlocked(true) inside its
  // "earned reward" callback (not on a plain dismiss/close).
  const watchAmpAd = () => {
    setAmpAdLoading(true);
    setAmpAdError(false);
    playRewardedAd(
      () => { setAmpAdLoading(false); setAmpAdUnlocked(true); },
      () => { setAmpAdLoading(false); setAmpAdError(true); }
    );
  };

  const renderAmp = () => {
    // Extreme-low-impedance warning is Amp-only (per review), so it's
    // layered on top of the shared getLoadStatus() result here rather
    // than changing that shared function (which Ohm also uses).
    let status = ampResult ? getLoadStatus(ampResult.finalLoad, t) : null;
    if (ampResult && ampResult.finalLoad < 1) {
      status = { type: "danger", msg: t.safeExtreme };
    }
    return (
      <ScrollView contentContainerStyle={styles.screenPad}>
        <View style={styles.calcHeaderCard}>
        <Header title={t.ampTitle} sub={t.ampSub} onBack={() => goHome(resetAmp)} />
      </View>
        <LangToggle lang={lang} setLang={setLang} />

        {!ampResult ? (
          <View>
            <View style={styles.field}>
              <FieldLabelRow icon="power" label={t.step1Amp} />
              <View style={styles.rmsWrap}>
                <TextInput
                  style={styles.rmsInput}
                  keyboardType="numeric"
                  value={ampRms}
                  onChangeText={setAmpRms}
                />
                <Text style={styles.rmsUnit}>{t.watt}</Text>
              </View>
            </View>
            <View style={styles.field}>
              <FieldLabelRow icon="qty" label={t.step2Amp} />
              <Stepper value={ampQty} onChange={setAmpQty} />
            </View>
            <View style={styles.field}>
              <FieldLabelRow icon="impedance" label={t.step3Amp} />
              <ImpedanceChips value={ampImpedance} onChange={setAmpImpedance} />
            </View>
            <View style={styles.field}>
              <FieldLabelRow icon="connection" label={t.step4Amp} />
              <ConnToggle value={ampConn} onChange={setAmpConn} t={t} />
              <Text style={styles.fieldHint}>
                {ampConn === "parallel" ? t.hintParallel : t.hintSeries}
              </Text>
            </View>
            <Btn style={styles.calcBtn} onPress={calcAmp}>
              <Text style={styles.calcBtnText}>{t.calculate}</Text>
            </Btn>
            {ampError && <InfoBox title={"⚠️ " + t.caution} amber>{t.ampPowerError}</InfoBox>}
            <InfoBox>{t.ampNote}</InfoBox>
          </View>
        ) : !ampAdUnlocked ? (
          <AdUnlockGate loading={ampAdLoading} error={ampAdError} onWatch={watchAmpAd} t={t} />
        ) : (
          <View>
            <View style={styles.resultBox}>
              <Text style={styles.resultLbl}>{t.totalLoad}</Text>
              <PopText value={ampResult.finalLoad} style={[styles.resultBig, { fontSize: 34 }]}>{ampResult.finalLoad}Ω</PopText>
              <StatusPill type={status.type} msg={status.msg} />
            </View>
            <Text style={styles.resultTitleLeft}>{t.suggestedAmp}</Text>
            <View style={styles.ampRow}>
              <Text style={styles.ampRowLbl}>{t.minLabel}</Text>
              <Text style={styles.ampRowVal}>{ampResult.min}W @ {ampResult.finalLoad}Ω</Text>
            </View>
            <View style={[styles.ampRow, styles.ampRowIdeal]}>
              <Text style={styles.ampRowLbl}>{t.idealLabel}</Text>
              <Text style={[styles.ampRowVal, { color: C.green }]}>{ampResult.ideal}W @ {ampResult.finalLoad}Ω</Text>
            </View>
            <View style={styles.ampRow}>
              <Text style={styles.ampRowLbl}>{t.maxLabel}</Text>
              <Text style={[styles.ampRowVal, { color: C.red }]}>{ampResult.max}W @ {ampResult.finalLoad}Ω</Text>
            </View>
            <InfoBox title={t.impedanceNoteTitle}>
              {t.impedanceNoteText.replace("{ohm}", ampResult.finalLoad)}
            </InfoBox>
            <InfoBox title={"⚠️ " + t.caution} amber>{t.cautionText}</InfoBox>
            <ActionRow
              onReset={resetAmp}
              t={t}
              shareText={buildShareText(t, [
                "🔊 " + t.step1Amp.replace(/^\d+\.\s*/, "") + ": " + ampRms + "W",
                "🎚️ " + t.step3Amp.replace(/^\d+\.\s*/, "") + ": " + ampImpedance + "Ω",
                "🔢 " + t.step2Amp.replace(/^\d+\.\s*/, "") + ": " + ampQty,
                "",
                "📊 " + t.totalLoad + ": " + ampResult.finalLoad + "Ω",
                t.shareRecAmpLabel,
                "",
                "✅ " + t.minLabel + ": " + ampResult.min + "W RMS",
                "⭐ " + t.idealLabel + ": " + ampResult.ideal + "W RMS",
                "⚠️ " + t.maxLabel + ": " + ampResult.max + "W RMS",
              ])}
            />
          </View>
        )}
      </ScrollView>
    );
  };

  // ---- Screen: TOP SPEAKER CALCULATOR ----
  const resetTop = () => { setTopResult(null); setTopError(false); setTopAdUnlocked(false); setTopAdLoading(false); setTopAdError(false); };
  const calcTop = () => {
    if (Number(topLf1Watt) < 200 || topLf1Watt === "" || Number(topLf2Watt) < 200 || topLf2Watt === "" || Number(topHfWatt) < 50 || topHfWatt === "") {
      setTopError(true);
      return; // don't calculate until fixed
    }
    setTopError(false);
    setTopAdUnlocked(false);
    setTopAdError(false);
    const lf1Watt = Number(topLf1Watt) || 0;
    const lf2Watt = Number(topLf2Watt) || 0;
    const hfWatt = Number(topHfWatt) || 0;
    setTopResult(calcTopResult(lf1Watt, lf2Watt, hfWatt));
  };
  const watchTopAd = () => {
    setTopAdLoading(true);
    setTopAdError(false);
    playRewardedAd(
      () => { setTopAdLoading(false); setTopAdUnlocked(true); },
      () => { setTopAdLoading(false); setTopAdError(true); }
    );
  };

  const renderTop = () => (
    <ScrollView contentContainerStyle={styles.screenPad}>
      <View style={styles.calcHeaderCard}>
        <Header title={t.topTitle} sub={t.topSub} onBack={() => goHome(resetTop)} />
      </View>
      <LangToggle lang={lang} setLang={setLang} />

      {!topResult ? (
        <View>
          <View style={styles.field}>
            <FieldLabelRow icon="lfSpeaker" label={t.step1Top} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={topLf1Watt}
                onChangeText={setTopLf1Watt}
              />
              <Text style={styles.rmsUnit}>{t.watt}</Text>
            </View>
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="lfSpeaker" label={t.step2Top} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={topLf2Watt}
                onChangeText={setTopLf2Watt}
              />
              <Text style={styles.rmsUnit}>{t.watt}</Text>
            </View>
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="hfDriver" label={t.step3Top} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={topHfWatt}
                onChangeText={setTopHfWatt}
              />
              <Text style={styles.rmsUnit}>{t.watt}</Text>
            </View>
          </View>
          <Btn style={styles.calcBtn} onPress={calcTop}>
            <Text style={styles.calcBtnText}>{t.calculate}</Text>
          </Btn>
          {topError && <InfoBox title={"⚠️ " + t.caution} amber>{t.topPowerError}</InfoBox>}
          <InfoBox>{t.plateNote}</InfoBox>
        </View>
      ) : !topAdUnlocked ? (
        <AdUnlockGate loading={topAdLoading} error={topAdError} onWatch={watchTopAd} t={t} />
      ) : (
        <View>
          <Text style={styles.resultTitleLeft}>{t.cabinetCalcTitle}</Text>
          <View style={styles.ampRow}>
            <Text style={styles.ampRowLbl}>{t.lf1Label}</Text>
            <Text style={styles.ampRowVal}>{topResult.lf1Watt}W</Text>
          </View>
          <View style={styles.ampRow}>
            <Text style={styles.ampRowLbl}>{t.lf2Label}</Text>
            <Text style={styles.ampRowVal}>{topResult.lf2Watt}W</Text>
          </View>
          <View style={styles.ampRow}>
            <Text style={styles.ampRowLbl}>{t.hfDriverLabel}</Text>
            <Text style={styles.ampRowVal}>{topResult.hfWatt}W</Text>
          </View>
          <View style={[styles.ampRow, styles.ampRowIdeal]}>
            <Text style={styles.ampRowLbl}>{t.totalCabinetPowerLabel}</Text>
            <Text style={[styles.ampRowVal, { color: C.green }]}>{topResult.cabinetPower}W RMS</Text>
          </View>
          <View style={styles.ampRow}>
            <Text style={styles.ampRowLbl}>{t.suggestedPlateLabel}</Text>
            <Text style={styles.ampRowVal}>{topResult.plate ? topResult.plate + "W" : t.plateCustomText}</Text>
          </View>

          <Text style={styles.resultTitleLeft}>{t.suggestedAmpForTop}</Text>
          <View style={styles.ampRow}>
            <Text style={styles.ampRowLbl}>{t.minLabel}</Text>
            <Text style={styles.ampRowVal}>{topResult.min}W</Text>
          </View>
          <View style={[styles.ampRow, styles.ampRowIdeal]}>
            <Text style={styles.ampRowLbl}>{t.idealLabel}</Text>
            <Text style={[styles.ampRowVal, { color: C.green }]}>{topResult.ideal}W</Text>
          </View>
          <View style={styles.ampRow}>
            <Text style={styles.ampRowLbl}>{t.maxLabel}</Text>
            <Text style={[styles.ampRowVal, { color: C.red }]}>{topResult.max}W</Text>
          </View>

          <InfoBox title={"⚠️ " + t.caution} amber>{t.cautionText}</InfoBox>
          <ActionRow
            onReset={resetTop}
            t={t}
            shareText={buildShareText(t, [
              "🔈 " + t.lf1Label + ": " + topResult.lf1Watt + "W",
              "🔈 " + t.lf2Label + ": " + topResult.lf2Watt + "W",
              "🎺 " + t.hfDriverLabel + ": " + topResult.hfWatt + "W",
              "",
              "📊 " + t.totalCabinetPowerLabel + ": " + topResult.cabinetPower + "W RMS",
              "🔌 " + t.suggestedPlateLabel + ": " + (topResult.plate ? topResult.plate + "W" : t.plateCustomText),
              t.shareRecAmpLabel,
              "",
              "✅ " + t.minLabel + ": " + topResult.min + "W",
              "⭐ " + t.idealLabel + ": " + topResult.ideal + "W",
              "⚠️ " + t.maxLabel + ": " + topResult.max + "W",
            ])}
          />
        </View>
      )}
    </ScrollView>
  );

  // ---- Screen: DMX ADDRESS CALCULATOR ----
  const resetDmx = () => { setDmxResult(null); setDmxError(false); setDmxAdUnlocked(false); setDmxAdLoading(false); setDmxAdError(false); };
  const calcDmx = () => {
    if (Number(dmxChannels) <= 0 || dmxChannels === "" || Number(dmxFixtures) <= 0 || dmxFixtures === "") {
      setDmxError(true);
      return; // don't calculate until fixed
    }
    setDmxError(false);
    setDmxAdUnlocked(false);
    setDmxAdError(false);
    const channels = Math.max(1, Number(dmxChannels) || 1);
    const start = Math.max(1, Number(dmxStart) || 1);
    const fixtures = Math.max(1, Number(dmxFixtures) || 1);
    setDmxResult(calcDmxResult(channels, fixtures, start));

    // Field-work progress: resume if the saved progress was for the
    // same total fixture count (likely the same job), else start fresh.
    Storage.getDmxProgress().then((saved) => {
      const restored = saved && saved.total === fixtures && Array.isArray(saved.flags) && saved.flags.length === fixtures
        ? saved.flags
        : new Array(fixtures).fill(false);
      setDmxFlags(restored);
    });
  };
  const watchDmxAd = () => {
    setDmxAdLoading(true);
    setDmxAdError(false);
    playRewardedAd(
      () => { setDmxAdLoading(false); setDmxAdUnlocked(true); },
      () => { setDmxAdLoading(false); setDmxAdError(true); }
    );
  };

  // Tapping a fixture directly flips just that one — lets a technician
  // work out of order, not just sequentially.
  const toggleDmxFixture = (i) => {
    const total = dmxResult ? dmxResult.addresses.length : 0;
    setDmxFlags((prev) => {
      const next = prev.slice();
      next[i] = !next[i];
      Storage.setDmxProgress(next, total);
      return next;
    });
  };

  // The +/- buttons are a quick sequential adjust: "+" marks the next
  // not-yet-done fixture, "−" unmarks the most recently done one.
  const adjustDmxProgress = (delta) => {
    const total = dmxResult ? dmxResult.addresses.length : 0;
    setDmxFlags((prev) => {
      const next = prev.slice();
      if (delta > 0) {
        const idx = next.indexOf(false);
        if (idx !== -1) next[idx] = true;
      } else {
        const idx = next.lastIndexOf(true);
        if (idx !== -1) next[idx] = false;
      }
      Storage.setDmxProgress(next, total);
      return next;
    });
  };

  const renderDmx = () => {
    const dmxConfigured = dmxFlags.filter(Boolean).length;
    const dmxTotal = dmxResult ? dmxResult.addresses.length : 0;
    const dmxPct = dmxTotal > 0 ? Math.round((dmxConfigured / dmxTotal) * 100) : 0;
    return (
    <ScrollView contentContainerStyle={styles.screenPad}>
      <View style={styles.calcHeaderCard}>
        <Header title={t.dmxTitle} sub={t.dmxSub} onBack={() => goHome(resetDmx)} />
      </View>
      <LangToggle lang={lang} setLang={setLang} />

      {!dmxResult ? (
        <View>
          <View style={styles.field}>
            <FieldLabelRow icon="channels" label={t.step1Dmx} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={dmxChannels}
                onChangeText={setDmxChannels}
              />
              <Text style={styles.rmsUnit}>{t.channelsUnit}</Text>
            </View>
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="fixtures" label={t.step2Dmx} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={dmxFixtures}
                onChangeText={setDmxFixtures}
              />
              <Text style={styles.rmsUnit}>{t.fixturesUnit}</Text>
            </View>
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="address" label={t.step3Dmx} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={dmxStart}
                onChangeText={setDmxStart}
              />
              <Text style={styles.rmsUnit}>{t.addressUnit}</Text>
            </View>
          </View>
          {dmxError && (
            <InfoBox title={"⚠️ " + t.caution} amber>{t.dmxChannelsError}</InfoBox>
          )}
          <Btn style={styles.calcBtn} onPress={calcDmx}>
            <Text style={styles.calcBtnText}>{t.calculate}</Text>
          </Btn>
        </View>
      ) : !dmxAdUnlocked ? (
        <AdUnlockGate loading={dmxAdLoading} error={dmxAdError} onWatch={watchDmxAd} t={t} />
      ) : (
        <View>
          <View style={[styles.infoBox, { marginBottom: 16 }]}>
            <Text style={[styles.infoBoxTitle, { textAlign: "center", marginBottom: 10 }]}>{t.dmxProgressTitle}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18 }}>
              <Btn style={[styles.actionBtn, { flex: 0, paddingHorizontal: 18 }]} onPress={() => adjustDmxProgress(-1)}>
                <Text style={[styles.actionBtnText, { fontSize: 18 }]}>−</Text>
              </Btn>
              <Text style={{ fontSize: 20, fontWeight: "800", color: C.text, minWidth: 80, textAlign: "center" }}>
                {dmxConfigured} / {dmxTotal}
              </Text>
              <Btn style={[styles.actionBtn, { flex: 0, paddingHorizontal: 18 }]} onPress={() => adjustDmxProgress(1)}>
                <Text style={[styles.actionBtnText, { fontSize: 18 }]}>+</Text>
              </Btn>
            </View>
            <View style={{ backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 999, height: 8, overflow: "hidden", marginTop: 14 }}>
              <View style={{ backgroundColor: C.amber, height: "100%", borderRadius: 999, width: dmxPct + "%" }} />
            </View>
            <Text style={{ textAlign: "center", fontSize: 12, color: C.muted, marginTop: 8 }}>
              {t.dmxProgressPercent.replace("{p}", dmxPct)}
            </Text>
          </View>
          <Text style={styles.resultTitleLeft}>{t.dmxResultTitle}</Text>
          <Text style={{ color: C.muted, fontSize: 11, marginTop: -4, marginBottom: 10 }}>{t.dmxTapHint}</Text>
          <View style={styles.dmxGrid}>
            {dmxResult.addresses.map((addr, i) => {
              const done = dmxFlags[i];
              return (
                <Btn key={i} onPress={() => toggleDmxFixture(i)} style={[styles.dmxGridItem, done && styles.dmxGridItemIdeal]}>
                  <Text style={styles.dmxGridLbl}>{done ? "✓ " : ""}{t.fixtureLabel.replace("{n}", i + 1)}</Text>
                  <PopText value={`${addr}-${done}`} style={[styles.dmxGridVal, done && { color: C.green }]}>
                    {String(addr).padStart(3, "0")}
                  </PopText>
                </Btn>
              );
            })}
          </View>
          {dmxResult.overLimit && (
            <InfoBox title={"⚠️ " + t.caution} amber>
              {t.dmxWarning.replace("{end}", dmxResult.lastEnd)}
            </InfoBox>
          )}
          <ActionRow
            onReset={resetDmx}
            t={t}
            shareText={buildShareText(t, [
              "🎚️ " + t.step1Dmx.replace(/^\d+\.\s*/, "") + ": " + dmxChannels,
              "💡 " + t.step2Dmx.replace(/^\d+\.\s*/, "") + ": " + dmxFixtures,
              "# " + t.step3Dmx.replace(/^\d+\.\s*/, "") + ": " + dmxStart,
              "",
              "📊 " + t.dmxResultTitle + ":",
              ...dmxResult.addresses.map((a, i) => t.fixtureLabel.replace("{n}", i + 1) + ": " + String(a).padStart(3, "0")),
            ])}
          />
        </View>
      )}
    </ScrollView>
    );
  };

  // ---- Screen: SPEAKER CABLE LOSS CALCULATOR ----
  const resetCable = () => { setCableResult(null); setCableError(false); };
  const calcCable = () => {
    if (Number(cablePower) < 100 || cablePower === "" || Number(cableLength) <= 0 || cableLength === "") {
      setCableError(true);
      return;
    }
    setCableError(false);
    const perSpeakerPower = Number(cablePower) || 0;
    const totalPower = perSpeakerPower * cableQty;
    const totalImpedance = cableConn === "parallel" ? Math.round((cableImpedance / cableQty) * 100) / 100 : cableImpedance * cableQty;
    const length = Number(cableLength) || 0;
    const resistivity = cableType === "cca" ? CCA_RESISTIVITY : COPPER_RESISTIVITY;
    setCableResult({ ...calcCableResult(totalPower, totalImpedance, length, resistivity), totalImpedance, totalPower });
  };

  const renderCable = () => (
    <ScrollView contentContainerStyle={styles.screenPad}>
      <View style={styles.calcHeaderCard}>
        <Header title={t.cableTitle} sub={t.cableSub} onBack={() => goHome(resetCable)} />
      </View>
      <LangToggle lang={lang} setLang={setLang} />

      {!cableResult ? (
        <View>
          <View style={styles.field}>
            <FieldLabelRow icon="power" label={t.step1Cable} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={cablePower}
                onChangeText={setCablePower}
              />
              <Text style={styles.rmsUnit}>{t.watt}</Text>
            </View>
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="qty" label={t.step2CableQty} />
            <Stepper value={cableQty} onChange={setCableQty} />
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="impedance" label={t.step3Cable} />
            <ImpedanceChips value={cableImpedance} onChange={setCableImpedance} />
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="connection" label={t.step4CableConn} />
            <ConnToggle value={cableConn} onChange={setCableConn} t={t} />
            <Text style={styles.fieldHint}>
              {cableConn === "parallel" ? t.hintParallel : t.hintSeries}
            </Text>
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="material" label={t.step5CableType} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn
                style={[styles.chip, cableType === "copper" && styles.chipActive, { flex: 1 }]}
                onPress={() => setCableType("copper")}
              >
                <Text style={[styles.chipText, cableType === "copper" && styles.chipTextActive]}>{t.cableTypeCopper}</Text>
              </Btn>
              <Btn
                style={[styles.chip, cableType === "cca" && styles.chipActive, { flex: 1 }]}
                onPress={() => setCableType("cca")}
              >
                <Text style={[styles.chipText, cableType === "cca" && styles.chipTextActive]}>{t.cableTypeCCA}</Text>
              </Btn>
            </View>
          </View>
          <View style={styles.field}>
            <FieldLabelRow icon="length" label={t.step6Cable} />
            <View style={styles.rmsWrap}>
              <TextInput
                style={styles.rmsInput}
                keyboardType="numeric"
                value={cableLength}
                onChangeText={setCableLength}
              />
              <Text style={styles.rmsUnit}>{t.metersUnit}</Text>
            </View>
          </View>
          <Btn style={styles.calcBtn} onPress={calcCable}>
            <Text style={styles.calcBtnText}>{t.calculate}</Text>
          </Btn>
          {cableError && <InfoBox title={"⚠️ " + t.caution} amber>{t.cableInputError}</InfoBox>}
          <InfoBox>{t.cableNote}</InfoBox>
        </View>
      ) : (
        <View>
          <Text style={styles.resultTitleLeft}>{t.cableResultTitle}</Text>
          <Text style={{ color: C.muted, fontSize: 12, marginTop: -6, marginBottom: 4 }}>
            {cableQty} × {cableImpedance}Ω ({cableConn === "parallel" ? t.parallel : t.series}) = {cableResult.totalImpedance}Ω, {cableResult.totalPower}W {t.watt.toLowerCase()} · {cableType === "cca" ? t.cableTypeCCA : t.cableTypeCopper}
          </Text>
          <Text style={{ color: C.muted, fontSize: 12, marginBottom: 12 }}>
            {t.cableCurrentText.replace("{i}", cableResult.current)}
          </Text>
          {cableResult.results.map((r) => {
            const tag =
              r.size === cableResult.recommended.size ? " ✅" :
              r.size === cableResult.best.size ? " ⭐" : "";
            return (
              <View key={r.size} style={styles.ampRow}>
                <Text style={styles.ampRowLbl}>{r.size} mm²{tag}</Text>
                <Text style={styles.ampRowVal}>{r.emoji} {t[r.statusKey]} ({r.dB.toFixed(2)} dB)</Text>
              </View>
            );
          })}
          <View style={[styles.ampRow, styles.ampRowIdeal, { flexDirection: "column", alignItems: "flex-start", gap: 4 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", width: "100%" }}>
              <Text style={styles.ampRowLbl}>{t.recommendedCableLabel}</Text>
              <Text style={[styles.ampRowVal, { color: C.green }]}>{cableResult.recommended.size} mm²</Text>
            </View>
            <Text style={{ fontSize: 11, color: C.muted }}>{t.recommendedCableSub}</Text>
          </View>
          <View style={[styles.ampRow, { flexDirection: "column", alignItems: "flex-start", gap: 4 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", width: "100%" }}>
              <Text style={styles.ampRowLbl}>{t.bestCableLabel}</Text>
              <Text style={styles.ampRowVal}>{cableResult.best.size} mm²</Text>
            </View>
            <Text style={{ fontSize: 11, color: C.muted }}>{t.bestCableSub}</Text>
          </View>
          <InfoBox>{t.cableDisclaimer}</InfoBox>
          <ActionRow
            onReset={resetCable}
            t={t}
            shareText={buildShareText(t, [
              "🔊 " + t.step1Cable.replace(/^\d+\.\s*/, "") + ": " + cablePower + "W",
              "🔢 " + t.step2CableQty.replace(/^\d+\.\s*/, "") + ": " + cableQty,
              "🎚️ " + t.step3Cable.replace(/^\d+\.\s*/, "") + ": " + cableImpedance + "Ω",
              "🔌 " + t.shareConnLabel + ": " + (cableConn === "parallel" ? t.parallel : t.series),
              "🧵 " + t.step5CableType.replace(/^\d+\.\s*/, "") + ": " + (cableType === "cca" ? t.cableTypeCCA : t.cableTypeCopper),
              "📏 " + t.step6Cable.replace(/^\d+\.\s*/, "") + ": " + cableLength + "m",
              "",
              "📊 " + cableResult.totalImpedance + "Ω, " + cableResult.totalPower + "W " + t.watt.toLowerCase(),
              "✅ " + t.recommendedCableLabel + ": " + cableResult.recommended.size + " mm²",
              "⭐ " + t.bestCableLabel + ": " + cableResult.best.size + " mm²",
            ])}
          />
        </View>
      )}
    </ScrollView>
  );

  // ---- Screen: INFO ----
  const renderInfo = () => (
    <ScrollView contentContainerStyle={styles.screenPad}>
      <Text style={styles.infoTitle}>{t.infoTitle}</Text>
      {t.infoItems.map((item, idx) => (
        <Btn
          key={item.t}
          style={styles.infoListItem}
          onPress={() => {
            if (item.key === "about") { setScreen("about"); return; }
            if (item.key === "contact") { setScreen("contact"); return; }
            setInfoDetailIndex(idx);
            setScreen("info-detail");
          }}
        >
          <View style={styles.infoListLeft}>
            <View style={styles.infoDot}>
              <Text style={{ color: C.amber }}>ℹ</Text>
            </View>
            <View>
              <Text style={styles.infoListT}>{item.t}</Text>
              <Text style={styles.infoListS}>{item.s}</Text>
            </View>
          </View>
          <Text style={{ color: C.muted }}>‹</Text>
        </Btn>
      ))}
      <BottomNav screen={screen} setScreen={setScreen} t={t} />
    </ScrollView>
  );

  // ---- Screen: INFO DETAIL ----
  const renderInfoDetail = () => {
    const item = t.infoItems[infoDetailIndex];
    return (
      <ScrollView contentContainerStyle={styles.screenPad}>
        <Header title={item.t} sub="" onBack={() => setScreen("info")} />
        <View style={styles.infoDetailBox}>
          <Text style={styles.infoDetailText}>{item.body}</Text>
          {item.contact && (
            <View style={{ marginTop: 12 }}>
              <Text
                style={styles.contactLink}
                onPress={() => Linking.openURL(`mailto:${item.contact.email}`)}
              >
                📧 {item.contact.email}
              </Text>
              <Text
                style={styles.contactLink}
                onPress={() => Linking.openURL(`https://instagram.com/${item.contact.instagram}`)}
              >
                📸 @{item.contact.instagram}
              </Text>
              <Text
                style={styles.contactLink}
                onPress={() => Linking.openURL(`https://youtube.com/@${item.contact.youtube}`)}
              >
                ▶️ {item.contact.youtube}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    );
  };

  // ---- Screen: ABOUT US ----
  const renderAbout = () => (
    <ScrollView contentContainerStyle={styles.screenPad}>
      <Header title={t.aboutTitle} sub="" onBack={() => setScreen("info")} />
      <View style={{ position: "relative", alignItems: "center", marginVertical: 8, marginBottom: 26, paddingTop: 8 }}>
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 66, flexDirection: "row", justifyContent: "center", alignItems: "flex-end", opacity: 0.14 }}>
          {[10, 30, 54, 22, 42, 14, 62, 30, 18, 0, 0, 0, 0, 0, 0, 18, 30, 62, 14, 42, 22, 54, 30, 10].map((h, i) =>
            h > 0 ? (
              <View key={i} style={{ width: 5, height: h, borderRadius: 2, backgroundColor: C.amber, marginHorizontal: 3 }} />
            ) : (
              <View key={i} style={{ width: 5, marginHorizontal: 3 }} />
            )
          )}
        </View>
        <View style={{
          width: 72, height: 72, borderRadius: 20,
          backgroundColor: "rgba(37,99,235,0.08)", borderWidth: 1, borderColor: "rgba(37,99,235,0.25)",
          alignItems: "center", justifyContent: "center", marginBottom: 16,
        }}>
          <Text style={{ fontSize: 32 }}>〰️</Text>
        </View>
        <Text style={{ fontSize: 22, fontWeight: "800", color: C.text, marginBottom: 4 }}>AmpOhm</Text>
        <Text style={{ color: C.amber, fontWeight: "700", fontSize: 13, marginBottom: 6 }}>{t.aboutVersion}</Text>
        <Text style={{ color: C.muted, fontSize: 12 }}>{t.aboutSubtitle}</Text>
      </View>
      <View style={[styles.infoBox, { marginBottom: 16 }]}>
        <Text style={{ fontSize: 13, color: C.muted, lineHeight: 20, marginBottom: 16 }}>{t.aboutIntro}</Text>
        <Text style={{ fontSize: 11, fontWeight: "700", color: C.amber, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
          {t.supportedCalcsLabel}
        </Text>
        <View style={{ gap: 9 }}>
          {[t.calcNameAmp, t.calcNameOhm, t.calcNameTop, t.calcNameCable, t.calcNameDmx].map((name) => (
            <View key={name} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ color: C.amber, fontSize: 14 }}>●</Text>
              <Text style={{ fontSize: 13, color: "#334155" }}>{name}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={[styles.ampRow, { marginBottom: 16 }]}>
        <Text style={styles.ampRowLbl}>{t.developedByLabel}</Text>
        <Text style={[styles.ampRowVal, { color: C.amber }]}>AudioXpert</Text>
      </View>
      <Text style={{ textAlign: "center", color: C.muted, fontSize: 11, marginTop: 16, marginBottom: 4 }}>{t.aboutVersion}</Text>
      <Text style={{ textAlign: "center", color: C.muted, fontSize: 11 }}>{t.aboutCopyright}</Text>
    </ScrollView>
  );

  // ---- Screen: CONTACT US ----
  const renderContact = () => (
    <ScrollView contentContainerStyle={styles.screenPad}>
      <Header title={t.contactTitle} sub="" onBack={() => setScreen("info")} />
      <View style={{ alignItems: "center", marginVertical: 8, marginBottom: 20 }}>
        <View style={{
          width: 72, height: 72, borderRadius: 20,
          backgroundColor: "rgba(37,99,235,0.08)", borderWidth: 1, borderColor: "rgba(37,99,235,0.25)",
          alignItems: "center", justifyContent: "center", marginBottom: 16,
        }}>
          <Text style={{ fontSize: 32 }}>📧</Text>
        </View>
        <Text style={{ fontSize: 19, fontWeight: "800", color: C.text, marginBottom: 8 }}>{t.contactHeading}</Text>
        <Text style={{ color: C.muted, fontSize: 13, textAlign: "center", lineHeight: 19 }}>{t.contactSub}</Text>
      </View>

      <Btn style={[styles.infoListItem, { padding: 16 }]} onPress={() => Linking.openURL("mailto:audioxpert123@gmail.com")}>
        <View style={styles.infoListLeft}>
          <View style={[styles.infoDot, { width: 44, height: 44 }]}><Text style={{ fontSize: 19 }}>📧</Text></View>
          <View>
            <Text style={styles.infoListT}>{t.emailLabel}</Text>
            <Text style={styles.infoListS}>audioxpert123@gmail.com</Text>
          </View>
        </View>
        <Text style={{ color: C.muted }}>‹</Text>
      </Btn>
      <Btn style={[styles.infoListItem, { padding: 16 }]} onPress={() => Linking.openURL("https://instagram.com/audio_xpert")}>
        <View style={styles.infoListLeft}>
          <View style={[styles.infoDot, { width: 44, height: 44 }]}><Text style={{ fontSize: 19 }}>📸</Text></View>
          <View>
            <Text style={styles.infoListT}>{t.instagramLabel}</Text>
            <Text style={styles.infoListS}>@audio_xpert</Text>
          </View>
        </View>
        <Text style={{ color: C.muted }}>‹</Text>
      </Btn>
      <Btn style={[styles.infoListItem, { padding: 16 }]} onPress={() => Linking.openURL("https://youtube.com/@audioxpertt")}>
        <View style={styles.infoListLeft}>
          <View style={[styles.infoDot, { width: 44, height: 44 }]}><Text style={{ fontSize: 19 }}>▶️</Text></View>
          <View>
            <Text style={styles.infoListT}>{t.youtubeLabel}</Text>
            <Text style={styles.infoListS}>AudioXpert</Text>
          </View>
        </View>
        <Text style={{ color: C.muted }}>‹</Text>
      </Btn>

      <View style={[styles.infoBox, { marginTop: 8 }]}>
        <Text style={{ fontSize: 12, color: C.muted, lineHeight: 18 }}>{t.contactReplyNote}</Text>
      </View>
    </ScrollView>
  );

  // =====================================================================
  // FUTURE INTEGRATIONS — see app.js (web build) for the matching
  // placeholders (Auth, addFavorite, logRecentCalculation,
  // checkForAppUpdate). Kept as comments here so both builds stay in
  // sync when those features are actually implemented.
  // =====================================================================

  let content;
  if (screen === "home") content = renderHome();
  else if (screen === "ohm") content = renderOhm();
  else if (screen === "amp") content = renderAmp();
  else if (screen === "top") content = renderTop();
  else if (screen === "dmx") content = renderDmx();
  else if (screen === "cable") content = renderCable();
  else if (screen === "info") content = renderInfo();
  else if (screen === "info-detail") content = renderInfoDetail();
  else if (screen === "about") content = renderAbout();
  else if (screen === "contact") content = renderContact();

  return (
    <ThemeContext.Provider value={{ C, styles }}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle={theme === "dark" ? "light-content" : "dark-content"} backgroundColor={C.bg} />
        {content}
        {/* Real AdMob banner, wired to Google's TEST ad unit ID for now
            (see src/ads.js). Sits outside the ScrollView so it stays
            fixed on every screen and never scrolls with the content. */}
        <View style={styles.adBannerBar}>
          <BannerAd
            unitId={AD_UNIT_IDS.banner}
            size={BannerAdSize.BANNER}
            onAdFailedToLoad={(err) => console.warn("Banner ad failed to load:", err)}
          />
        </View>
        <View style={styles.homeIndicatorBar}>
          <View style={styles.homeIndicatorPill} />
        </View>
      </SafeAreaView>
    </ThemeContext.Provider>
  );
}

// =====================================================================
// STYLES
// =====================================================================
function buildStyles(C) {
  return StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: C.bg },
  screenPad: { padding: 20, paddingBottom: 40 },

  topBarRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  menuWrap: { position: "relative" },
  menuBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  menuBtnText: { color: C.text, fontSize: 15 },
  menuDropdown: {
    position: "absolute",
    top: 40,
    left: 0,
    zIndex: 20,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 6,
    minWidth: 160,
    shadowColor: "#0f172a",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  menuItem: { paddingVertical: 9, paddingHorizontal: 10, borderRadius: 10 },
  menuItemText: { color: C.text, fontSize: 13, fontWeight: "600" },
  topLangPill: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  topLangPillText: { color: C.text, fontSize: 12, fontWeight: "600" },

  // ---- Brand header ----
  brand: { alignItems: "center", marginVertical: 18, position: "relative" },
  // Sits behind the logo/wordmark only — scoped to this block, not
  // the whole screen.
  brandEq: { position: "absolute", top: -12, alignSelf: "center" },
  brandLogoRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  brandLogoBox: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: C.amber,
    alignItems: "center",
    justifyContent: "center",
  },
  brandLogoGlyph: { color: "#ffffff", fontSize: 17, fontWeight: "900" },
  brandTextRow: { flexDirection: "row", alignItems: "center" },
  brandText: { fontSize: 28, fontWeight: "900", color: C.text, letterSpacing: -0.7 },
  // "Ohm" as a solid gradient badge (not gradient-clipped text, which
  // can render invisible on some devices).
  brandAccentBadge: {
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 1,
    marginLeft: 2,
  },
  brandAccentText: { color: "#ffffff", fontWeight: "900", fontSize: 25 },
  tagline: { color: C.muted, fontSize: 13, marginTop: 2 },
  trustRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  trustItem: { color: C.muted, fontSize: 12, fontWeight: "600" },
  trustDivider: { color: C.border, fontSize: 12 },

  // ---- Section headers (AUDIO TOOLS / LIGHTING TOOLS) ----
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 18, marginBottom: 12 },
  sectionBar: { width: 4, height: 16, borderRadius: 2, backgroundColor: C.amber },
  sectionLabel: { color: C.text, fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },

  // Full-bleed absolute layer — used for the card's gradient
  // background and its CardArt illustration, both painted behind the
  // normal-flow icon/title/sub/chevron content that follows them.
  fill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },

  // ---- Home tool grid (2-column) ----
  gridWrap: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  gridCard: {
    width: "48%",
    backgroundColor: C.amber, // fallback under the LinearGradient layer
    borderRadius: 18,
    padding: 16,
    paddingBottom: 40,
    marginBottom: 14,
    minHeight: 150,
    overflow: "hidden",
    position: "relative",
  },
  gridCardIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.95)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  gridCardIcon: { fontSize: 18, color: C.amberDark, fontWeight: "800" },
  gridCardTitle: { color: "#ffffff", fontWeight: "800", fontSize: 15, marginBottom: 4 },
  gridCardSub: { color: "rgba(255,255,255,0.85)", fontSize: 11, lineHeight: 15 },
  gridChevron: {
    position: "absolute",
    right: 14,
    bottom: 14,
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  gridChevronText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },

  // ---- Full-width tool card (Lighting Tools / DMX) ----
  fullCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.amber, // fallback under the LinearGradient layer
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    position: "relative",
    overflow: "hidden",
  },
  fullCardBody: { flex: 1, marginLeft: 14, paddingRight: 30 },

  cardBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 999,
    backgroundColor: C.amber,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  iconCircleText: { color: "#ffffff", fontWeight: "900", fontSize: 18 },
  cardTitle: { color: C.text, fontWeight: "700", fontSize: 15 },
  cardSub: { color: C.muted, fontSize: 12 },

  soonBox: {
    borderWidth: 1,
    borderColor: C.border,
    borderStyle: "dashed",
    borderRadius: 18,
    padding: 16,
    alignItems: "center",
    backgroundColor: C.card,
  },
  soonLabel: { color: C.muted, fontSize: 12, marginBottom: 8 },
  soonItem: { color: C.muted, fontSize: 12, marginVertical: 2 },

  // Premium floating pill nav — card-style container with its own
  // shadow; the active tab gets a gradient pill with a matching glow.
  bottomNav: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: C.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(226,232,240,0.9)",
    padding: 5,
    marginTop: 16,
    gap: 6,
    shadowColor: "#0f172a",
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  navItem: { flex: 1 },
  navItemInner: { alignItems: "center", justifyContent: "center", paddingVertical: 9, borderRadius: 15, gap: 4 },
  navItemActiveFill: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    borderRadius: 15,
    gap: 4,
    shadowColor: C.amber,
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  navIcon: { fontSize: 20, lineHeight: 22 },
  navItemText: { color: C.muted, fontSize: 11, fontWeight: "700" },

  headerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  // Wraps each calculator's Header — same rounded/bordered card
  // language as the home screen tool cards, at a very low, premium
  // opacity fill instead of a solid blue background.
  calcHeaderCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(37,99,235,0.16)",
    backgroundColor: "rgba(37,99,235,0.04)",
    padding: 12,
    marginBottom: 18,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  headerTitle: { color: C.text, fontSize: 17, fontWeight: "700" },
  headerSub: { color: C.muted, fontSize: 12 },

  langWrap: {
    flexDirection: "row",
    alignSelf: "center",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    padding: 4,
    marginBottom: 20,
  },
  langBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  langBtnActive: { backgroundColor: C.amber },
  langBtnText: { color: C.muted, fontSize: 12, fontWeight: "600" },
  langBtnTextActive: { color: "#ffffff" },

  field: { marginBottom: 20 },
  fieldLabel: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 8 },
  fieldLabelRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  fieldHint: { color: C.muted, fontSize: 11, marginTop: 8, lineHeight: 16 },

  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    overflow: "hidden",
  },
  stepperBtn: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.soft,
  },
  stepperBtnText: { color: C.text, fontSize: 18 },
  stepperVal: { flex: 1, textAlign: "center", color: C.text, fontWeight: "700", fontSize: 18 },

  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: C.card,
  },
  chipActive: { borderColor: C.amber, backgroundColor: "rgba(37,99,235,0.08)" },
  chipText: { color: C.muted, fontWeight: "600" },
  chipTextActive: { color: C.amber },

  connGrid: { flexDirection: "row", gap: 12 },
  connBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    gap: 8,
    backgroundColor: C.card,
  },
  connBtnActive: { borderColor: C.amber, backgroundColor: "rgba(37,99,235,0.06)" },
  connGlyph: { fontSize: 20, color: C.muted },
  connText: { color: C.muted, fontWeight: "600", fontSize: 13 },
  connTextActive: { color: C.amber },

  rmsWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    overflow: "hidden",
  },
  rmsInput: { flex: 1, color: C.text, fontWeight: "700", fontSize: 16, paddingHorizontal: 16, paddingVertical: 14 },
  rmsUnit: { color: C.muted, fontSize: 13, paddingHorizontal: 16, borderLeftWidth: 1, borderLeftColor: C.border, paddingVertical: 14 },

  calcBtn: { backgroundColor: C.amber, borderRadius: 14, paddingVertical: 15, alignItems: "center", marginTop: 4 },
  calcBtnText: { color: "#ffffff", fontWeight: "800", fontSize: 15 },

  resultTitle: { textAlign: "center", color: C.muted, fontWeight: "700", fontSize: 14, marginBottom: 12 },
  resultTitleLeft: { color: C.muted, fontWeight: "700", fontSize: 14, marginBottom: 10, marginTop: 4 },

  resultBox: {
    borderWidth: 1,
    borderColor: "rgba(22,163,74,0.3)",
    backgroundColor: "rgba(22,163,74,0.06)",
    borderRadius: 18,
    padding: 22,
    alignItems: "center",
    marginBottom: 16,
  },
  resultLbl: { color: C.muted, fontSize: 12, marginBottom: 4 },
  resultBig: { fontSize: 46, fontWeight: "900", color: C.green, marginVertical: 8 },

  statusPill: { borderWidth: 1, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14 },
  statusPillText: { fontSize: 12, fontWeight: "600" },

  infoBox: {
    backgroundColor: C.soft,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
  },
  infoBoxAmber: { backgroundColor: "rgba(37,99,235,0.05)", borderColor: "rgba(37,99,235,0.2)" },
  infoBoxTitle: { fontSize: 12, fontWeight: "700", marginBottom: 4, color: C.text },
  infoBoxText: { fontSize: 12, color: C.muted, lineHeight: 18 },

  actionRow: { flexDirection: "row", gap: 12, marginTop: 16 },
  actionBtn: { flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingVertical: 11, alignItems: "center", backgroundColor: C.card },
  actionBtnText: { color: C.text, fontSize: 13, fontWeight: "600" },

  ampRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.soft,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  ampRowIdeal: { borderColor: "rgba(22,163,74,0.3)", backgroundColor: "rgba(22,163,74,0.06)" },
  ampRowLbl: { color: C.muted, fontSize: 13 },
  ampRowVal: { color: C.text, fontSize: 16, fontWeight: "800" },

  // DMX fixture list — 2-column grid so long fixture counts don't
  // force a very long single scroll. Separate from ampRow (used by
  // other calculators' results) so nothing else is affected.
  dmxGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  dmxGridItem: {
    width: "48%",
    backgroundColor: C.soft,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    padding: 9,
    marginBottom: 8,
  },
  dmxGridItemIdeal: { borderColor: "rgba(22,163,74,0.3)", backgroundColor: "rgba(22,163,74,0.06)" },
  dmxGridLbl: { fontSize: 11, color: C.muted },
  dmxGridVal: { fontSize: 15, fontWeight: "800", color: C.text, marginTop: 2 },

  infoTitle: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 16 },
  infoListItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  },
  infoListLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  infoDot: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: C.soft,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  infoListT: { color: C.text, fontSize: 13, fontWeight: "600" },
  infoListS: { color: C.muted, fontSize: 11 },

  infoDetailBox: { backgroundColor: C.soft, borderRadius: 14, padding: 14 },
  infoDetailText: { color: C.text, fontSize: 13, lineHeight: 22 },
  contactLink: { color: C.amber, fontSize: 13, lineHeight: 24 },

  // ---- Reward-ad unlock gate (Amp / Top / DMX results) ----
  adGateBorder: { borderRadius: 22, padding: 1.5, marginBottom: 16 },
  adGate: {
    borderRadius: 21,
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  adGateIcon: { fontSize: 40, marginBottom: 12 },
  adGateTitle: { color: "#fff", fontWeight: "800", fontSize: 18, marginBottom: 6, textAlign: "center" },
  adGateSub: { color: "rgba(255,255,255,0.85)", fontSize: 12.5, lineHeight: 18, textAlign: "center", marginBottom: 20, maxWidth: 240 },
  adGateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
    borderRadius: 999,
    paddingVertical: 13,
    paddingHorizontal: 26,
    minWidth: 90,
  },
  adGateBtnText: { color: C.amberDark, fontWeight: "800", fontSize: 14 },
  adGateError: { color: "#fff", fontSize: 12, marginTop: 12, textAlign: "center", opacity: 0.9 },

  // ---- Bottom banner-ad placeholder strip + home-indicator safe area ----
  adBannerBar: {
    height: 50,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.soft,
    borderTopWidth: 1,
    borderTopColor: C.border,
    flexDirection: "row",
    gap: 8,
  },
  adBannerLabel: {
    backgroundColor: C.muted,
    color: "#fff",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  adBannerText: { color: C.muted, fontSize: 11, fontWeight: "600" },
  homeIndicatorBar: { height: 22, alignItems: "center", justifyContent: "center", backgroundColor: C.bg },
  homeIndicatorPill: { width: 120, height: 4, borderRadius: 999, backgroundColor: C.muted, opacity: 0.6 },
  });
}

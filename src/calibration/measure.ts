/**
 * What a window's audio looks like, independent of the speech model.
 *
 * The speech model answers "is this speech"; this answers "why" — where the energy sits,
 * and whether it moves the way a voice does. A window that scores low with its energy
 * packed at 100–300 Hz is room rumble; one that scores low with energy across the speech
 * band is a quiet utterance the model missed. Those need different fixes, and a verdict
 * alone cannot tell them apart.
 */

/** The frequencies a report names, in Hz — enough to separate rumble from a voice. */
export const BAND_FREQUENCIES = [100, 200, 300, 500, 800, 1200, 2000, 3000, 4000];

export interface BandEnergy {
  frequency: number;
  /** Relative to the window's strongest band, so a quiet window is not misread as silent. */
  db: number;
}

export interface WindowMeasure {
  seconds: number;
  /** Mean fraction of samples whose sign changes per frame — low for rumble, higher for speech. */
  zeroCrossingRate: number;
  bands: BandEnergy[];
}

export function measureWindow(samples: Int16Array, rate: number): WindowMeasure {
  const frame = Math.max(1, Math.round(rate * 0.06));
  const seconds = samples.length / rate;

  let crossings = 0;
  let counted = 0;
  let loudestAt = 0;
  let loudest = -1;
  for (let offset = 0; offset + frame <= samples.length; offset += frame) {
    let energy = 0;
    for (let index = offset; index < offset + frame; index++) {
      energy += samples[index]! ** 2;
      if (index > offset && (samples[index]! < 0) !== (samples[index - 1]! < 0)) crossings += 1;
    }
    counted += frame;
    if (energy > loudest) {
      loudest = energy;
      loudestAt = offset;
    }
  }

  const chunk = samples.subarray(loudestAt, loudestAt + frame);
  const powers = BAND_FREQUENCIES.map((frequency) => ({
    frequency,
    power: goertzel(chunk, rate, frequency),
  }));
  const strongest = Math.max(...powers.map((band) => band.power), 0);

  return {
    seconds,
    zeroCrossingRate: counted === 0 ? 0 : crossings / counted,
    bands: powers.map((band) => ({
      frequency: band.frequency,
      db: strongest === 0 || band.power === 0 ? -99 : round(10 * Math.log10(band.power / strongest)),
    })),
  };
}

/** The energy at one frequency, as a DFT bin's power, without a spectral library. */
function goertzel(samples: Int16Array, rate: number, frequency: number): number {
  const w = (2 * Math.PI * frequency) / rate;
  const coefficient = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const sample of samples) {
    const s0 = sample + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (samples.length ** 2);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

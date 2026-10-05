// A Machine's paired scale, auxiliary scale and sensors, put together from
// the collections its tablet reports: `pairedDevices` (Decaid's device
// inventory without devices only discovered nearby), `scaleInfo` (the
// connected scale's own report), `sensors` (connected sensors' manifests) and
// `appSettings` (which scale Decaid prefers). Decaid's payloads are opaque,
// so every field is optional here, and one of another type is left out.

/** A device paired with a Machine's tablet, as the REST API returns it. */
export interface PairedDeviceView {
  /** Decaid's id for it, such as a Bluetooth address. */
  id: string;
  /** Decaid's kind of device: machine, scale or sensor. */
  type: string | null;
  /** As Decaid names it, which names its model, such as Bookoo Mini Scale. */
  model: string | null;
  /** A sensor's vendor, from its manifest. */
  vendor: string | null;
  /** Decaid's connection state when last reported, such as connected or disconnected. */
  state: string | null;
  /** Reported by a connected scale that reports it; Decaid v0.8.7 reads it only from Skale2 scales. */
  firmware: string | null;
  /** A percentage, reported as the firmware is. */
  batteryLevel: number | null;
}

export interface PairedDevicesView {
  /** When the tablet last reported its paired devices; null if it never has. */
  reportedAt: string | null;
  /** The scale that weighs shots: the one Decaid has connected as its primary scale, or else the scale it prefers. */
  scale: PairedDeviceView | null;
  /** A second scale Decaid has connected for something else, such as weighing ground coffee. */
  auxiliaryScale: PairedDeviceView | null;
  sensors: PairedDeviceView[];
  /** Every other paired device, such as the machine itself or another scale Decaid remembers. */
  others: PairedDeviceView[];
}

/** A collection's latest report, as stored. */
export interface Report {
  available: boolean;
  reportedAt: Date;
  value: unknown;
}

interface Entry {
  view: PairedDeviceView;
  role: string | null;
}

export function pairedDevicesView(reports: {
  pairedDevices: Report | null;
  scaleInfo: Report | null;
  sensors: Report | null;
  appSettings: Report | null;
}): PairedDevicesView {
  const entries = list(reports.pairedDevices?.value).flatMap((device): Entry[] => {
    const id = text(device.id);
    if (id === null) return [];
    return [{ view: deviceView(id, text(device.type), text(device.name), text(device.state)), role: text(device.connectionRole) }];
  });
  const scales = entries.filter((entry) => entry.view.type === "scale");
  const preferredScale = text(object(reports.appSettings?.value)?.preferredScaleId);
  const scale =
    scales.find((entry) => entry.role === "primary") ?? scales.find((entry) => entry.role === null && entry.view.id === preferredScale) ?? null;
  const auxiliaryScale = scales.find((entry) => entry.role === "auxiliary") ?? null;

  // The scale's own report describes whichever scale is connected as primary.
  const scaleInfo = reports.scaleInfo?.available ? object(reports.scaleInfo.value) : null;
  if (scale?.role === "primary" && scale.view.state === "connected" && scaleInfo) {
    scale.view.firmware = text(scaleInfo.firmwareVersion);
    scale.view.batteryLevel = typeof scaleInfo.batteryLevel === "number" && Number.isFinite(scaleInfo.batteryLevel) ? scaleInfo.batteryLevel : null;
  }

  // Decaid lists connected sensors with their manifests, including some, such as a Bengle's milk probe, its inventory leaves out.
  const manifests = list(reports.sensors?.value).flatMap((sensor) => {
    const id = text(sensor.id);
    return id === null ? [] : [{ id, info: object(sensor.info) }];
  });
  const sensorEntries = entries.filter((entry) => entry.view.type === "sensor");
  const sensors = sensorEntries.map((entry) => entry.view);
  if (reports.sensors?.available) {
    for (const { id } of manifests) if (!sensors.some((sensor) => sensor.id === id)) sensors.push(deviceView(id, "sensor", null, "connected"));
  }
  for (const sensor of sensors) {
    const info = manifests.find((manifest) => manifest.id === sensor.id)?.info;
    sensor.model ??= text(info?.name);
    sensor.vendor = text(info?.vendor);
  }

  const shown = new Set<Entry | null>([scale, auxiliaryScale, ...sensorEntries]);
  return {
    reportedAt: reports.pairedDevices?.reportedAt.toISOString() ?? null,
    scale: scale?.view ?? null,
    auxiliaryScale: auxiliaryScale?.view ?? null,
    sensors,
    others: entries.filter((entry) => !shown.has(entry)).map((entry) => entry.view),
  };
}

function deviceView(id: string, type: string | null, model: string | null, state: string | null): PairedDeviceView {
  return { id, type, model, vendor: null, state, firmware: null, batteryLevel: null };
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => (object(item) ? [item as Record<string, unknown>] : [])) : [];
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

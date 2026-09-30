/* Minimal stroke icons for Herald (inline SVG, inherit currentColor). */
import type { ReactNode } from 'react';
interface IconProps { size?: number }

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconSend = (p: IconProps) => <Svg {...p}><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></Svg>;
export const IconClose = (p: IconProps) => <Svg {...p}><path d="M18 6L6 18" /><path d="M6 6l12 12" /></Svg>;
export const IconX = (p: IconProps) => <Svg {...p}><path d="M17 7L7 17" /><path d="M7 7l10 10" /></Svg>;
export const IconBack = (p: IconProps) => <Svg {...p}><path d="M15 18l-6-6 6-6" /></Svg>;
export const IconMore = (p: IconProps) => (
  <Svg {...p}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Svg>
);
export const IconCheck = (p: IconProps) => <Svg {...p}><path d="M20 6L9 17l-5-5" /></Svg>;
export const IconAlert = (p: IconProps) => (
  <Svg {...p}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /></Svg>
);
export const IconClock = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const IconDown = (p: IconProps) => <Svg {...p}><path d="M12 5v14" /><path d="M19 12l-7 7-7-7" /></Svg>;
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 3v5h-5" /></Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></Svg>
);
export const IconSpeaker = (p: IconProps) => (
  <Svg {...p}><path d="M11 5L6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 010 7" /><path d="M18.4 5.6a9 9 0 010 12.8" /></Svg>
);
export const IconSpeakerOff = (p: IconProps) => (
  <Svg {...p}><path d="M11 5L6 9H3v6h3l5 4V5z" /><path d="M22 9l-6 6" /><path d="M16 9l6 6" /></Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="6.5" y="6.5" width="11" height="11" rx="2.2" /></Svg>
);
export const IconBell = (p: IconProps) => (
  <Svg {...p}><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></Svg>
);
export const IconPlay = (p: IconProps) => <Svg {...p}><path d="M7 5l12 7-12 7V5z" /></Svg>;
export const IconMic = (p: IconProps) => (
  <Svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></Svg>
);
export const IconMicOff = (p: IconProps) => (
  <Svg {...p}><path d="M15 9.5V6a3 3 0 0 0-5.7-1.3" /><path d="M9 9v2a3 3 0 0 0 4.6 2.5" /><path d="M5 11a7 7 0 0 0 11.3 5.5" /><path d="M19 11a7 7 0 0 1-.4 2.3" /><path d="M12 18v3" /><path d="M3 3l18 18" /></Svg>
);
export const IconListen = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="1.6" /><path d="M8.6 8.6a4.8 4.8 0 0 0 0 6.8" /><path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8" /><path d="M5.8 5.8a8.8 8.8 0 0 0 0 12.4" /><path d="M18.2 5.8a8.8 8.8 0 0 1 0 12.4" /></Svg>
);
/** "Brief me": what's new, read out. */
export const IconBrief = (p: IconProps) => (
  <Svg {...p}><path d="M4 6h10" /><path d="M4 12h7" /><path d="M4 18h10" /><path d="M16 10l5 3-5 3v-6z" /></Svg>
);

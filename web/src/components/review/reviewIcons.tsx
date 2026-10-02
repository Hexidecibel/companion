/** Small stroke icons for Code Review (16px grid, currentColor). */
import type { SVGProps } from 'react';

function Svg(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export const IconCheck = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M3.5 8.5l3 3 6-7" /></Svg>;
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M6 3.5L10.5 8 6 12.5" /></Svg>;
export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M3.5 6L8 10.5 12.5 6" /></Svg>;
export const IconClose = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
export const IconUndo = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M5.5 4L2.5 7l3 3" /><path d="M2.5 7h7a4 4 0 010 8h-2" /></Svg>;
export const IconRevert = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M3 3v4h4" /><path d="M3.3 7A5 5 0 1 1 4.5 11.8" /></Svg>;
export const IconAsk = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /><path d="M6.6 6.1a1.5 1.5 0 112.1 1.4c-.5.2-.7.5-.7 1" /><path d="M8 9.6v.01" /></Svg>
);
export const IconCopy = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" /></Svg>;
export const IconComment = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M2.5 3.5h11v7.5h-7l-3 2.5v-2.5h-1z" /></Svg>;
export const IconFile = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M4 1.8h5l3 3V14.2H4z" /><path d="M9 1.8v3h3" /></Svg>;
export const IconOpen = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5L7.5 8.5" /><path d="M11.5 9.5v3.5a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V5a.5.5 0 01.5-.5h3.5" /></Svg>;
export const IconAlert = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M8 2l6.3 11H1.7z" /><path d="M8 6.5v3" /><path d="M8 11.5v.01" /></Svg>;
export const IconFlame = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><path d="M8 14c2.5 0 4.2-1.7 4.2-4 0-2.6-2.2-4-2.7-6.5C8.2 5 7.5 6.3 7.5 7.6 6.6 7 6.2 6.2 6 5.2 4.6 6.5 3.8 8 3.8 10c0 2.3 1.7 4 4.2 4z" /></Svg>;
export const IconLive = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><circle cx="8" cy="8" r="2" /><path d="M4.5 4.5a5 5 0 000 7M11.5 4.5a5 5 0 010 7" /></Svg>;
export const IconKeyboard = (p: SVGProps<SVGSVGElement>) => <Svg {...p}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" /></Svg>;

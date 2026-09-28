import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, strokeWidth = 2, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 20h14" />
  </Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);
export const IconKey = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9" />
    <path d="M17 6l3 3" />
  </Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h10" />
    <path d="M18 6h2" />
    <circle cx="16" cy="6" r="2" />
    <path d="M4 18h4" />
    <path d="M12 18h8" />
    <circle cx="10" cy="18" r="2" />
    <path d="M4 12h2" />
    <path d="M10 12h10" />
    <circle cx="8" cy="12" r="2" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M9 5v14" />
    <path d="M15 5v14" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7 5l12 7-12 7z" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </Svg>
);
export const IconChevron = ({ open, ...p }: P & { open?: boolean }) => (
  <Svg {...p} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.9-3" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.9 3" />
    <path d="M20 20v-4h-4" />
  </Svg>
);
export const IconArchive = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M5 12l5 5 9-10" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M9 7V4h6v3" />
  </Svg>
);
export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
    <path d="M10 16l-4-4 4-4" />
    <path d="M6 12h10" />
  </Svg>
);
export const Logo = () => (
  <div className="logo-mark">
    <IconDownload size={16} strokeWidth={2.5} />
  </div>
);

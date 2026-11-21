import React from 'react';

interface BarcodeSvgProps {
  value: string;
  width?: number;
  height?: number;
  showText?: boolean;
  className?: string;
}

export const BarcodeSvg: React.FC<BarcodeSvgProps> = ({
  value,
  width = 180,
  height = 50,
  showText = true,
  className = '',
}) => {
  // Generate deterministic barcode pattern based on string characters
  const generateBars = (code: string) => {
    const bars: { x: number; w: number }[] = [];
    let currentX = 10;
    const totalBars = 35;
    
    // Guard bars at start
    bars.push({ x: currentX, w: 2 });
    currentX += 3;
    bars.push({ x: currentX, w: 1 });
    currentX += 4;

    // Encode characters
    for (let i = 0; i < totalBars; i++) {
      const charCode = code.charCodeAt(i % code.length) || 48;
      const isThick = (charCode + i * 7) % 3 === 0;
      const w = isThick ? 3 : 1.5;
      bars.push({ x: currentX, w });
      const space = ((charCode + i * 3) % 2 === 0 ? 3 : 2);
      currentX += w + space;
      if (currentX > width - 15) break;
    }

    // Guard bars at end
    bars.push({ x: currentX, w: 2 });
    currentX += 3;
    bars.push({ x: currentX, w: 1.5 });

    return { bars, maxX: currentX + 10 };
  };

  const { bars, maxX } = generateBars(value || '000000000000');

  return (
    <div className={`inline-flex flex-col items-center select-none ${className}`}>
      <svg
        viewBox={`0 0 ${maxX} ${height}`}
        style={{ width: `${width}px`, height: `${height}px` }}
        className="overflow-visible"
      >
        <rect width={maxX} height={height} fill="#ffffff" />
        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={2}
            width={bar.w}
            height={height - 4}
            fill="#1e293b"
          />
        ))}
      </svg>
      {showText && (
        <span className="font-mono text-xs tracking-widest text-slate-700 mt-1">
          {value}
        </span>
      )}
    </div>
  );
};

import { createContext, useContext } from 'react';
import type { ReactNode, MouseEvent, HTMLAttributes, Ref } from 'react';

type CardDensity = 'normal' | 'dense';

const CardDensityContext = createContext<CardDensity>('normal');

export function CardDensityProvider({ density, children }: { density: CardDensity; children: ReactNode }) {
  return <CardDensityContext.Provider value={density}>{children}</CardDensityContext.Provider>;
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  /**
   * Opt-in hover affordance for clickable cards (grid tiles, list rows).
   * Adds a sub-100ms lift + green border on hover. Leave off for static
   * container/modal cards so they don't drift on hover.
   */
  interactive?: boolean;
  ref?: Ref<HTMLDivElement>;
}

interface CardSectionProps {
  children: ReactNode;
  className?: string;
  dense?: boolean;
}

export function Card({ children, className = '', onClick, onContextMenu, interactive = false, ...rest }: CardProps) {
  const interactiveCls = interactive
    ? 'transition-[transform,box-shadow,border-color] duration-100 ease-out cursor-pointer hover:-translate-y-0.5 hover:border-bambu-green/40 hover:shadow-lg motion-reduce:hover:translate-y-0 motion-reduce:transition-none'
    : '';
  return (
    <div
      className={`bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary card-shadow ${interactiveCls} ${!interactive && onClick ? 'cursor-pointer' : ''} ${className}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className = '', dense }: CardSectionProps) {
  const ctxDense = useContext(CardDensityContext) === 'dense';
  const isDense = dense ?? ctxDense;
  const padding = isDense ? 'px-4 py-2.5' : 'px-6 py-4';
  return (
    <div className={`${padding} border-b border-bambu-dark-tertiary ${className}`}>
      {children}
    </div>
  );
}

export function CardContent({ children, className = '', dense }: CardSectionProps) {
  const ctxDense = useContext(CardDensityContext) === 'dense';
  const isDense = dense ?? ctxDense;
  const padding = isDense ? 'p-4' : 'p-6';
  return <div className={`${padding} ${className}`}>{children}</div>;
}

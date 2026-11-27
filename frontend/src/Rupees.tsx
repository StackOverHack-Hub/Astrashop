import { amount } from './format';

export function Rupees({ value }: { value: number }) {
  return <><span className="rupee">₹</span>{amount(value)}</>;
}

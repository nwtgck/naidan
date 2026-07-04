declare module 'virtual:naidan-tailwind' {
  declare const tailwindClassBrand: unique symbol;

  export type TailwindClass = string & {
    readonly [tailwindClassBrand]: 'TailwindClass',
  };

  export type TailwindClassValue = TailwindClass | false | null | undefined;

  export function tw(className: string): TailwindClass;
  export function twClasses(value: TailwindClassValue | readonly TailwindClassValue[]): string;
  export function twClassString(...classNames: string[]): TailwindClass;
  export function customClasses(value: unknown): unknown;
}

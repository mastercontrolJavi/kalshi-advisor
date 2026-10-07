import * as React from 'react';
import {Slot} from '@radix-ui/react-slot';
import {cva,type VariantProps} from 'class-variance-authority';
import {cn} from '@/lib/utils';
const buttonVariants=cva('inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[background-color,border-color,transform] duration-150 active:scale-[.98] disabled:pointer-events-none disabled:opacity-45',{variants:{variant:{default:'bg-yes px-4 text-bg hover:bg-yes/85',outline:'border border-line-strong bg-surface-2 px-4 hover:border-faint',ghost:'px-3 text-muted hover:text-fg'},size:{default:'h-11',sm:'h-10 px-3'}},defaultVariants:{variant:'default',size:'default'}});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>,VariantProps<typeof buttonVariants>{asChild?:boolean}
export const Button=React.forwardRef<HTMLButtonElement,ButtonProps>(({className,variant,size,asChild=false,...props},ref)=>{const Comp=asChild?Slot:'button';return <Comp className={cn(buttonVariants({variant,size,className}))} ref={ref} {...props}/>;});Button.displayName='Button';

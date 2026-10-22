import * as React from 'react';
import {cn} from '@/lib/utils';
export const Input=React.forwardRef<HTMLInputElement,React.InputHTMLAttributes<HTMLInputElement>>(({className,type,...props},ref)=><input type={type} ref={ref} className={cn('num flex h-11 w-full rounded-[14px] border border-line-strong bg-bg/70 px-3.5 text-[15px] text-fg transition-colors hover:border-faint focus-visible:border-info',className)} {...props}/>);Input.displayName='Input';

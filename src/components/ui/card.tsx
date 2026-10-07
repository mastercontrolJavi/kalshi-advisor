import * as React from 'react';
import {cn} from '@/lib/utils';
export const Card=React.forwardRef<HTMLDivElement,React.HTMLAttributes<HTMLDivElement>>(({className,...props},ref)=><div ref={ref} className={cn('rounded-2xl border border-line bg-surface/85 p-5 shadow-[0_1px_0_0_rgb(255_255_255/0.03)_inset] backdrop-blur-sm',className)} {...props}/>);Card.displayName='Card';

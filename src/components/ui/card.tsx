import * as React from 'react';
import {cn} from '@/lib/utils';
export const Card=React.forwardRef<HTMLDivElement,React.HTMLAttributes<HTMLDivElement>>(({className,...props},ref)=><div ref={ref} className={cn('rounded-[22px] border border-line/80 bg-surface/85 bg-linear-to-b from-surface-2/70 to-surface/85 p-5 shadow-[0_1px_0_0_rgb(255_255_255/0.06)_inset,0_24px_48px_-28px_rgb(0_0_0/0.85)] backdrop-blur-md',className)} {...props}/>);Card.displayName='Card';

import { AsyncLocalStorage } from "node:async_hooks";

type Output = (delta: string | null) => void;
const output = new AsyncLocalStorage<Output>();

export const withHermesOutput = <T>(receive: Output, run: () => Promise<T>) => output.run(receive, run);
export const currentHermesOutput = () => output.getStore();

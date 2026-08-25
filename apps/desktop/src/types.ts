export interface ServerEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group?: string;
  authMethod: 'password' | 'publicKey' | 'agent';
}

import { SignedXml } from 'xml-crypto';
import forge from 'node-forge';
import { DOMParser } from '@xmldom/xmldom';
import { verifyXmlSignature } from './app/lib/s2sClient.ts';

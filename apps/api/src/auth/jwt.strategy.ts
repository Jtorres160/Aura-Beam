import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("NEXTAUTH_SECRET") || "aura-beam-super-secret-key-for-development",
    });
  }

  async validate(payload: any) {
    const userId = payload.id || payload.sub;
    if (!userId) {
      throw new UnauthorizedException("Invalid token payload");
    }
    return { id: userId, email: payload.email, role: payload.role };
  }
}
